// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Zero dependencies, so the server answers `initialize` at once, before the
// native addon is installed or loaded.

import { createInterface } from "node:readline";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * @param {{ name: string, version: string, instructions: string,
 *   tools: Array<{ name: string, description: string, inputSchema: object, annotations?: object }>,
 *   call: (name: string, args: object, ctx: { requestId: unknown }) => Promise<{ content: object[], isError?: boolean }>,
 *   cancel: (requestId: unknown) => void, log: (msg: string) => void }} server
 */
export function serveStdio(server) {
	const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
	const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
	const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

	async function handle(msg) {
		const { id, method, params } = msg;
		const isRequest = id !== undefined && id !== null;
		switch (method) {
			case "initialize": {
				const asked = params?.protocolVersion;
				return reply(id, {
					protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: server.name, version: server.version },
					instructions: server.instructions,
				});
			}
			case "ping":
				return isRequest && reply(id, {});
			case "tools/list":
				return reply(id, { tools: server.tools });
			case "tools/call": {
				const name = params?.name;
				if (!server.tools.some(t => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
				try {
					return reply(id, await server.call(name, params?.arguments ?? {}, { requestId: id }));
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return reply(id, { content: [{ type: "text", text }], isError: true });
				}
			}
			case "notifications/cancelled":
				return server.cancel(params?.requestId);
			default:
				if (method?.startsWith("notifications/")) return;
				if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
		}
	}

	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on("line", line => {
		if (!line.trim()) return;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return fail(null, -32700, "Parse error");
		}
		handle(msg).catch(error => server.log(`handler error: ${error?.stack ?? error}`));
	});
	rl.on("close", () => process.exit(0));
}
