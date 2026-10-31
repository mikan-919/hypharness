import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "test-server", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
  { name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "inspect", description: "Check isolation", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "Report an error", inputSchema: { type: "object", properties: {} } },
  { name: "disconnect", description: "Disconnect after responding", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === "fail") return { content: [{ type: "text", text: `server error ${process.env.FIXTURE_TOKEN ?? ""}` }], isError: true };
  if (params.name === "disconnect") { setTimeout(() => process.exit(0), 20); return { content: [{ type: "text", text: "bye" }] }; }
  if (params.name === "inspect") {
    let hidden = false;
    try { hidden = !(await Bun.file("/workspace/.env").text()); } catch { hidden = true; }
    return { content: [{ type: "text", text: JSON.stringify({ token: process.env.FIXTURE_TOKEN, path: process.env.PATH ?? null, home: process.env.HOME ?? null, hidden }) }] };
  }
  return { content: [{ type: "text", text: String(params.arguments?.text ?? "") }] };
});
await server.connect(new StdioServerTransport());
