import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema, Tool } from "@earendil-works/pi-ai";
import type { Store } from "./db.ts";
import { sandboxCommand } from "./sandbox.ts";

type StdioConfig = { command: string; args?: string[]; env?: Record<string, string> };
type HttpConfig = { type: "http"; url: string; headers?: Record<string, string> };
type Config = StdioConfig | HttpConfig;
type Server = { name: string; config: Config; client?: Client; connecting?: Promise<Client>; tools: Tool[] };

function strings(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(v => typeof v === "string");
}
function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Server configuration must be an object");
  const c = value as Record<string, unknown>;
  if (c.type === "http") {
    if (typeof c.url !== "string" || !["http:", "https:"].includes(new URL(c.url).protocol)) throw new Error("HTTP server requires an HTTP(S) URL");
    if (c.headers !== undefined && !strings(c.headers)) throw new Error("headers must contain strings");
    return { type: "http", url: c.url, headers: c.headers as Record<string, string> | undefined };
  }
  if (c.type !== undefined && c.type !== "stdio") throw new Error("Unsupported server type");
  if (typeof c.command !== "string" || !c.command) throw new Error("stdio server requires a command");
  if (c.args !== undefined && (!Array.isArray(c.args) || !c.args.every(x => typeof x === "string"))) throw new Error("args must be an array of strings");
  if (c.env !== undefined && !strings(c.env)) throw new Error("env must contain strings");
  return { command: c.command, args: c.args as string[] | undefined, env: c.env as Record<string, string> | undefined };
}

export class McpTools {
  private servers = new Map<string, Server>();
  private routes = new Map<string, { server: Server; tool: string }>();
  private constructor(private store: Store, private workspace: string) {}

  static async open(store: Store, workspace: string, log: (line: string) => void = console.error) {
    const manager = new McpTools(store, workspace);
    if (!store.db.filename || store.db.filename === ":memory:") return manager;
    const file = Bun.file(join(dirname(store.db.filename), "mcp.json"));
    if (!await file.exists()) return manager;
    let configs: Record<string, unknown>;
    try {
      const data = await file.json() as { mcpServers?: unknown };
      if (!data || typeof data.mcpServers !== "object" || data.mcpServers === null || Array.isArray(data.mcpServers)) throw new Error("mcpServers must be an object");
      configs = data.mcpServers as Record<string, unknown>;
    } catch { log("MCP configuration: invalid or unreadable mcp.json"); return manager; }
    await Promise.all(Object.entries(configs).map(async ([name, value]) => {
      try {
        const server: Server = { name, config: parseConfig(value), tools: [] };
        await manager.connect(server);
        manager.servers.set(name, server);
      } catch (error) { log(`MCP ${name}: ${manager.safeError(value, error)}`); }
    }));
    for (const server of manager.servers.values()) for (const schema of server.tools) {
      // Providers reject the whole request when one tool name is invalid, so such a tool is left out instead.
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(schema.name)) { log(`MCP ${server.name}: unsupported tool name ${schema.name}`); continue; }
      if (manager.routes.has(schema.name)) { log(`MCP ${server.name}: duplicate tool name ${schema.name}`); continue; }
      manager.routes.set(schema.name, { server, tool: schema.name.slice(`mcp__${server.name}__`.length) });
    }
    return manager;
  }

  private safeError(value: unknown, error: unknown) {
    let text = error instanceof Error ? error.message : String(error);
    if (value && typeof value === "object") {
      const c = value as Record<string, unknown>;
      const secrets = [...(strings(c.env) ? Object.values(c.env) : []), ...(strings(c.headers) ? Object.values(c.headers) : []), ...(typeof c.url === "string" ? [c.url] : [])];
      for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
    }
    return text;
  }

  private async connect(server: Server): Promise<Client> {
    if (server.client) return server.client;
    if (server.connecting) return server.connecting;
    const connecting = (async () => {
      const client = new Client({ name: "hypharness", version: "1" });
      const c = server.config;
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      if ("url" in c) transport = new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers } });
      else {
        const command = c.command === "bun" ? process.execPath : c.command.includes("/") ? c.command : Bun.which(c.command);
        if (!command) throw new Error(`Executable not found: ${c.command}`);
        const argv = sandboxCommand(this.workspace, command, c.args ?? [], c.env ?? {});
        // PATH and HOME are needed by the sandbox, but must not reach a server unless configured.
        const end = argv.length - (c.args?.length ?? 0) - 2;
        const unset = ["PATH", "HOME"].filter(key => !(key in (c.env ?? {}))).flatMap(key => ["--unsetenv", key]);
        argv.splice(end, 0, ...unset);
        transport = new StdioClientTransport({ command: argv[0]!, args: argv.slice(1), env: {}, stderr: "ignore" });
      }
      client.onclose = () => { if (server.client === client) server.client = undefined; };
      try {
        await client.connect(transport, { timeout: 15_000 });
        const schemas: Tool[] = []; let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
          for (const tool of page.tools) schemas.push({ name: `mcp__${server.name}__${tool.name}`, description: tool.description ?? "", parameters: tool.inputSchema as TSchema });
          cursor = page.nextCursor;
        } while (cursor);
        server.tools = schemas;
        server.client = client;
        return client;
      } catch (e) { await client.close().catch(() => {}); throw e; }
    })();
    server.connecting = connecting;
    try { return await connecting; } finally { server.connecting = undefined; }
  }

  schemas(): Tool[] { return [...this.routes.keys()].map(name => this.routes.get(name)!.server.tools.find(t => t.name === name)!).filter(Boolean); }
  has(name: string) { return this.routes.has(name); }

  async call(name: string, args: Record<string, unknown>, agent: string) {
    const route = this.routes.get(name);
    if (!route) throw new Error(`Unknown MCP tool ${name}`);
    const { server, tool } = route;
    let client: Client;
    try { client = await this.connect(server); }
    catch (error) { throw new Error(this.safeError(server.config, error)); }
    if (!server.tools.some(t => t.name === name)) throw new Error(`MCP tool ${name} is no longer available`);
    let result;
    try { result = await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { timeout: 60_000 }); }
    catch (error) { throw new Error(this.safeError(server.config, error)); }
    if (!Array.isArray(result.content)) throw new Error("MCP tool returned invalid content");
    const raw = result.content.map((part: { type: string; text?: string }) => part.type === "text" ? part.text ?? "" : JSON.stringify(part)).join("\n");
    if (result.isError) throw new Error(this.safeError(server.config, new Error(raw)));
    const id = this.store.tx(() => {
      const id = this.store.id("K"), source = `mcp:${server.name}/${tool}`;
      this.store.run("insert into knowledge(id, gist, summary, raw, source, status, author, created_at) values(?, ?, ?, ?, ?, 'hypothesis', ?, ?)", id, `${name} result`, raw.slice(0, 500), raw, source, agent, Date.now());
      if (this.store.meta("resident") === "1") {
        const domain = this.store.get<{ id: string }>("select id from domains where status = 'active' order by id limit 1");
        if (!domain) throw new Error("No active memory domain");
        this.store.run("insert into domain_knowledge(domain, knowledge) values(?, ?)", domain.id, id);
      }
      this.store.log(agent, "knowledge_added", { id, source });
      return id;
    });
    return `Recorded ${id} as unverified knowledge\n${raw}`;
  }

  async close() { await Promise.allSettled([...this.servers.values()].map(s => s.client?.close())); }
}
