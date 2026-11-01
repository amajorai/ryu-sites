import { afterEach, describe, expect, test } from "bun:test";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";

Reflect.set(globalThis, "__RYU_SITE_MCP__", {
	siteUrl: "https://notes.example.test",
	tools: [
		{
			name: "list_notes",
			operation: "records.list",
			collection: "notes",
		},
		{
			name: "save_note",
			operation: "records.set",
			collection: "notes",
		},
		{
			name: "delete_note",
			operation: "records.delete",
			collection: "notes",
		},
		{
			name: "search_docs",
			operation: "knowledge.search",
			collection: "docs",
		},
	],
});

const { requestMcp } = await import("./mcp-transport.ts");

interface ToolCall {
	args: SiteDataValue;
	name: string;
}

function installBridge(
	response: (call: ToolCall) => SiteDataValue | Promise<SiteDataValue>
): ToolCall[] {
	const calls: ToolCall[] = [];
	Reflect.set(globalThis, "openai", {
		callTool: async (name: string, args: SiteDataValue) => {
			const call = { args, name };
			calls.push(call);
			return response(call);
		},
	});
	return calls;
}

const success = (result: SiteDataValue) => ({ structuredContent: { result } });

afterEach(() => {
	Reflect.deleteProperty(globalThis, "openai");
});

describe("Site MCP Apps production transport", () => {
	test("maps every published record control to its exact tool and filters keyed reads", async () => {
		const calls = installBridge(({ name }) =>
			name === "list_notes"
				? success([
						{ key: "first", value: { title: "First" } },
						{ key: "second", value: { title: "Second" } },
					])
				: success({ saved: true })
		);

		expect(await requestMcp("records/notes/second", "GET")).toEqual([
			{ key: "second", value: { title: "Second" } },
		]);
		expect(
			await requestMcp("records/notes/second", "PUT", { title: "Changed" })
		).toEqual({ saved: true });
		expect(await requestMcp("records/notes/second", "DELETE")).toEqual({
			saved: true,
		});
		expect(calls).toEqual([
			{ name: "list_notes", args: {} },
			{
				name: "save_note",
				args: { key: "second", value: { title: "Changed" } },
			},
			{ name: "delete_note", args: { key: "second" } },
		]);
	});

	test("reads identity and capabilities only through the reserved context tool", async () => {
		const calls = installBridge(() =>
			success({
				identity: { email: "visitor@example.test" },
				capabilities: { mode: "connected" },
			})
		);

		expect(await requestMcp("identity", "GET")).toEqual({
			email: "visitor@example.test",
		});
		expect(await requestMcp("config", "GET")).toEqual({ mode: "connected" });
		expect(calls).toEqual([
			{ name: "ryu_site_context", args: {} },
			{ name: "ryu_site_context", args: {} },
		]);
	});

	test("keeps concurrent calls isolated when the host completes them out of order", async () => {
		const resolvers = new Map<string, (value: SiteDataValue) => void>();
		const calls = installBridge(
			({ name }) =>
				new Promise((resolve) => {
					resolvers.set(name, resolve);
				})
		);
		const search = requestMcp("search", "POST", { query: "deployment" });
		const records = requestMcp("records/notes", "GET");
		await Promise.resolve();

		resolvers.get("list_notes")?.(success([{ key: "one", value: 1 }]));
		resolvers.get("search_docs")?.(success({ passages: ["Deploy safely"] }));
		expect(await records).toEqual([{ key: "one", value: 1 }]);
		expect(await search).toEqual({ passages: ["Deploy safely"] });
		expect(calls).toEqual([
			{ name: "search_docs", args: { query: "deployment" } },
			{ name: "list_notes", args: {} },
		]);
	});

	test("surfaces host refusal exactly and retries only after an explicit second call", async () => {
		let attempts = 0;
		const calls = installBridge(() => {
			attempts += 1;
			return attempts === 1
				? {
						isError: true,
						content: [{ type: "text", text: "Visitor grant was revoked." }],
					}
				: success([{ key: "restored", value: true }]);
		});

		await expect(requestMcp("records/notes", "GET")).rejects.toThrow(
			"Visitor grant was revoked."
		);
		expect(calls).toHaveLength(1);
		expect(await requestMcp("records/notes", "GET")).toEqual([
			{ key: "restored", value: true },
		]);
		expect(calls).toHaveLength(2);
	});

	test("refuses missing keys, unpublished tools, invalid paths and malformed results before claiming success", async () => {
		const calls = installBridge(() => ({ unexpected: true }));

		await expect(
			requestMcp("records/notes", "PUT", { title: "No key" })
		).rejects.toThrow("A record key is required");
		await expect(requestMcp("records/notes", "DELETE")).rejects.toThrow(
			"A record key is required"
		);
		await expect(requestMcp("records/private", "GET")).rejects.toThrow(
			"Publish a matching record tool"
		);
		await expect(requestMcp("files", "POST", {})).rejects.toThrow(
			"Open the Site in a browser"
		);
		expect(calls).toHaveLength(0);

		await expect(requestMcp("records/notes", "GET")).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
});
