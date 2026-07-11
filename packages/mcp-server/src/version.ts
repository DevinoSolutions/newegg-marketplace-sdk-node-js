/**
 * Identity of this MCP server as advertised to clients (the MCP `Implementation`
 * record) and surfaced in the `newegg://capabilities` resource. Kept in a single
 * module so the server name/version never drift between registrations.
 */
export const SERVER_NAME = "newegg-marketplace-mcp";
export const SERVER_VERSION = "0.1.0";
