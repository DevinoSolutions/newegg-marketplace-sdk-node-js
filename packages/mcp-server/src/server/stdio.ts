/**
 * stdio transport wiring. Protocol messages are the only bytes written to stdout; the transport
 * owns stdout entirely. All logging elsewhere goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Connects the given server to a stdio transport and starts listening. */
export async function connectStdioTransport(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
