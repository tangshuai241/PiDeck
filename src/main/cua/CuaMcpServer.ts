/**
 * CuaMcpServer — MCP Server factory exposing CUA tools to pi.
 *
 * Architecture (Plan A, decided after the T7 blocker):
 * - The MCP server runs INSIDE the PiDeck Electron main process, served over
 *   the Streamable HTTP transport (see CuaMcpHttpHost). This keeps screen
 *   capture available (desktopCapturer is Electron-only) and matches the
 *   original design intent: no separate CUA subprocess is exposed.
 * - pi's pi-mcp-adapter connects via the `url` field in ~/.pi/agent/mcp.json.
 * - Tool registration lives in CuaTools.ts, shared with any other transport.
 *
 * Security: real mouse/keyboard input is injected. Write tools route through
 * CuaEngine → CuaGate (kill switch + user approval).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CuaEngine } from "./CuaEngine";
import type { CuaGate } from "./CuaGate";
import type { CuaScreen } from "./CuaScreen";
import { registerCuaTools } from "./CuaTools";

/**
 * Create a fresh McpServer instance with all CUA tools registered.
 *
 * One instance per MCP session/transport: the SDK requires a 1:1 binding
 * between a Server and a connected transport.
 */
export function createCuaMcpServer(engine: CuaEngine, gate: CuaGate, screen: CuaScreen): McpServer {
	const server = new McpServer(
		{ name: "pideck-cua", version: "0.1.0" },
		{
			capabilities: {
				tools: {},
			},
		},
	);

	registerCuaTools(server, engine, gate, screen);

	return server;
}
