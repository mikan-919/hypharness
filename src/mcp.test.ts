import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { openResident } from "./resident.ts";
import { remember } from "./resident-memory.ts";
import { sandboxShell } from "./sandbox.ts";
import { McpTools } from "./mcp.ts";
import { runEpisode } from "./agent.ts";
import { runScheduler } from "./scheduler.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hyph-mcp-")), workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures", "mcp-server.ts")], outdir: workspace, target: "bun" });
  if (!build.success) throw new Error("Failed to bundle fake MCP server");
  const store = openResident(join(dir, "state.sqlite"));
  await Bun.write(join(workspace, ".env"), "fixture private text");
  const config = { mcpServers: { fake: { command: "bun", args: ["/workspace/mcp-server.js"], env: { FIXTURE_TOKEN: "fixture-value" } }, broken: { command: "no-such-fixture-secret", env: { TOKEN: "fixture-secret" } } } };
  await Bun.write(join(dir, "mcp.json"), JSON.stringify(config));
  const log: string[] = [];
  const manager = await McpTools.open(store, workspace, line => log.push(line), async () => [1, 0]);
  if (!manager.has("mcp__fake__echo")) throw new Error(log.join("; "));
  return { dir, workspace, store, manager, log };
}

function sandboxUsable() {
  if (!Bun.which("bwrap")) return false;
  const workspace = mkdtempSync(join(tmpdir(), "hyph-mcp-probe-"));
  const result = Bun.spawnSync(sandboxShell(workspace, "true"), { stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

test("no MCP configuration adds no tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-mcp-empty-"));
  const store = openResident(join(dir, "state.sqlite"));
  const manager = await McpTools.open(store, dir);
  expect(manager.schemas()).toEqual([]);
  await manager.close(); store.db.close();
});

test("streamable HTTP uses the configured local URL and headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-mcp-http-")), store = openResident(join(dir, "state.sqlite"));
  const server = new Server({ name: "http-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
    { name: "hello", description: "Say hello", inputSchema: { type: "object", properties: {} } },
    { name: "dotted.name", description: "Not a valid provider tool name", inputSchema: { type: "object", properties: {} } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "local response" }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  await server.connect(transport);
  const seenHeaders: (string | null)[] = [], log: string[] = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => { seenHeaders.push(req.headers.get("x-fixture")); return transport.handleRequest(req); } });
  const manager = await (async () => {
    await Bun.write(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { local: { type: "http", url: `${http.url}mcp`, headers: { "x-fixture": "test-header" } } } }));
    return McpTools.open(store, dir, line => log.push(line), async () => [1, 0]);
  })();
  try {
    expect(manager.has("mcp__local__hello")).toBe(true);
    expect(manager.schemas().map(t => t.name)).toEqual(["mcp__local__hello"]);
    expect(log).toContain("MCP local: unsupported tool name mcp__local__dotted.name");
    expect(await manager.call("mcp__local__hello", {}, "worker")).toContain("local response");
    expect(seenHeaders.at(-1)).toBe("test-header");
    expect(store.get<{ source: string }>("select source from knowledge")!.source).toBe("mcp:local/hello");
  } finally { await manager.close(); await server.close(); http.stop(true); store.db.close(); }
});

test("streamable HTTP with oauth sends the token saved by mcp-login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-mcp-oauth-")), store = openResident(join(dir, "state.sqlite"));
  const server = new Server({ name: "oauth-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: {} } }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  await server.connect(transport);
  const seen: (string | null)[] = [], log: string[] = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => { seen.push(req.headers.get("authorization")); return transport.handleRequest(req); } });
  await Bun.write(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { paper: { type: "http", url: `${http.url}mcp`, oauth: true } } }));
  await Bun.write(join(dir, "mcp-auth.json"), JSON.stringify({ paper: { tokens: { access_token: "saved-token", token_type: "Bearer" } } }));
  const manager = await McpTools.open(store, dir, line => log.push(line), async () => [1, 0]);
  try {
    expect(manager.has("mcp__paper__search")).toBe(true);
    expect(seen.at(-1)).toBe("Bearer saved-token");
  } finally { await manager.close(); await server.close(); http.stop(true); store.db.close(); }
});

test.skipIf(!sandboxUsable())("stdio MCP tools are isolated, reconnect, and persist full results", async () => {
  const { store, manager, log } = await fixture();
  try {
    expect(log.some(s => s.includes("broken") && s.includes("Executable not found"))).toBe(true);
    expect(log.join(" ")).not.toContain("fixture-secret");
    const echo = manager.schemas().find(t => t.name === "mcp__fake__echo")!;
    expect(echo.description).toBe("Echo a value");
    expect(echo.parameters).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    const inspection = await manager.call("mcp__fake__inspect", {}, "worker");
    expect(inspection).toContain('"token":"fixture-value"');
    expect(inspection).toContain('"path":null');
    expect(inspection).toContain('"home":null');
    expect(inspection).toContain('"hidden":true');
    await expect(manager.call("mcp__fake__fail", {}, "worker")).rejects.toThrow("server error [redacted]");
    await manager.call("mcp__fake__disconnect", {}, "worker");
    await Bun.sleep(200);
    expect(await manager.call("mcp__fake__echo", { text: "after reconnect" }, "worker")).toContain("after reconnect");
    expect(store.get<{ status: string; raw: string }>("select status, raw from knowledge where source = 'mcp:fake/echo'")).toEqual({ status: "hypothesis", raw: "after reconnect" });
    expect(store.get<{ n: number }>("select count(*) n from knowledge k left join domain_knowledge d on d.knowledge = k.id where d.knowledge is null")!.n).toBe(0);
  } finally { await manager.close(); store.db.close(); }
});

test.skipIf(!sandboxUsable())("agent receives MCP tools and the output limit preserves full knowledge", async () => {
  const { dir, workspace, store, manager } = await fixture();
  try {
    store.addAgent("worker", "worker", null);
    store.run("insert into goals(id, parent, description, status, owner, created_at) values('G1','G0','work','open','worker',1)");
    const taskId = store.addTask({ goal: "G1", kind: "work", author: "host", assignee: "worker", description: "work" });
    store.claim(taskId, "worker");
    const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
    const text = "x".repeat(6000);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__fake__echo", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxToolCall("mcp__fake__echo", { text })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxToolCall("task_finish", { result: "done" })], { stopReason: "toolUse" })]);
    await runEpisode({ store, models, model: faux.getModel(), workspace, contextDir: join(dir, "contexts"), mcp: manager }, store.agent("worker")!, store.task(taskId)!);
    const raw = store.get<{ raw: string }>("select raw from knowledge where source = 'mcp:fake/echo'")!.raw;
    expect(raw).toBe(text);
    const messages: Message[] = JSON.parse(store.get<{ messages: string }>("select messages from episodes")!.messages);
    const results = messages.filter(m => m.role === "toolResult" && m.toolName === "mcp__fake__echo");
    expect(results[0]).toMatchObject({ isError: true });
    const response = results[1];
    expect(JSON.stringify(response)).toContain("truncated");
    expect(JSON.stringify(response).length).toBeLessThan(5000);
  } finally { await manager.close(); store.db.close(); }
});

test.skipIf(!sandboxUsable())("MCP output enters the nearest domain", async () => {
  const { store, manager } = await fixture();
  try {
    await remember(store, async () => [0, 1], "first", "test");
    store.run("insert into domains(id, name, description, steward, status) values('D-z', 'z', 'z', 'z', 'active')");
    const [near] = await remember(store, async () => [1, 0], "near", "test");
    store.run("update domain_knowledge set domain = 'D-z' where knowledge = ?", near);
    await manager.call("mcp__fake__echo", { text: "result" }, "worker");
    expect(store.get<{ domain: string }>("select d.domain from domain_knowledge d join knowledge k on k.id = d.knowledge where k.source = 'mcp:fake/echo'")!.domain).toBe("D-z");
  } finally { await manager.close(); store.db.close(); }
});

test.skipIf(!sandboxUsable())("scheduler connects configured servers before assigning work", async () => {
  const { dir, workspace, store, manager } = await fixture();
  await manager.close();
  try {
    store.addAgent("worker", "worker", null);
    store.run("insert into goals(id, parent, description, status, owner, created_at) values('G1','G0','work','open','worker',1)");
    store.addTask({ goal: "G1", kind: "work", author: "host", assignee: "worker", description: "work" });
    const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__fake__echo", { text: "scheduler result" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxToolCall("task_finish", { result: "done" })], { stopReason: "toolUse" })]);
    await runScheduler({ store, models, model: faux.getModel(), workspace, contextDir: join(dir, "contexts"), log: () => {}, embed: async () => [1, 0] }, 1);
    expect(store.get<{ raw: string }>("select raw from knowledge where source = 'mcp:fake/echo'")!.raw).toBe("scheduler result");
  } finally { store.db.close(); }
});
