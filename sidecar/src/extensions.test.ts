import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createSitesConnections } from "./connections.ts";
import type { SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { connectionRevision, sitePlugin } from "./extension-routes.ts";
import { approvedConnection, siteExtensions } from "./extensions.ts";
import { createSitesServer } from "./server.ts";
import { SitesStore } from "./store.ts";
import { visitorScript } from "./visitor-bundle.ts";

const owner: SitePrincipal = {
	id: "owner",
	email: "owner@example.com",
	workspaceIds: ["team"],
};
const reader: SitePrincipal = {
	id: "reader",
	email: "reader@example.com",
	workspaceIds: ["team"],
};
const connection = approvedConnection.parse({
	id: "issues",
	label: "My issues",
	toolId: "tracker.list",
	agentId: "ryu",
	readOnly: true,
});
let activeConnection = connection;
const calls: string[] = [];
const records = new Map<string, { key: string; value: SiteDataValue }>();
const store = new SitesStore(":memory:");
const site = store.create({ name: "Todo tools", slug: "todo-tools" }, owner);
store.db
	.query("INSERT INTO artifacts VALUES(?,?,?)")
	.run(site.id, "version-1", "<!doctype html><title>Todo tools</title>");
const extensions = siteExtensions.parse({
	mcp: true,
	ui: true,
	tools: [
		{
			name: "list_todos",
			description: "List my todos",
			operation: "records.list",
			collection: "todos",
		},
		{
			name: "save_todo",
			description: "Save my todo",
			operation: "records.set",
			collection: "todos",
		},
	],
	connections: [connection.id],
});
store.mutate(site.id, 0, (current) => {
	current.settings.mode = "connected";
	current.settings.audience = "workspace";
	current.settings.workspaceId = "team";
	current.settings.storage = true;
	current.settings.database = { spaceId: "space", databaseId: "db" };
	current.settings.extensions = extensions;
	current.versions = [
		{
			id: "version-1",
			message: "Tools",
			createdAt: new Date().toISOString(),
			bytes: 50,
			commit: null,
			extensions,
		},
	];
	current.deploymentId = "version-1";
	current.hasPublished = true;
});
const server = createSitesServer({
	store,
	token: "test-only-app-token",
	port: 0,
	visitorPort: 0,
	visitorScript,
	services: {
		authorizationServer: "https://identity.example.com",
		identity: async (request) =>
			request.headers.get("cookie") === "reader"
				? reader
				: request.headers.get("cookie") === "owner"
					? owner
					: null,
		mcpIdentity: async (request) =>
			request.headers.get("authorization") === "Bearer reader"
				? reader
				: request.headers.get("authorization") === "Bearer owner"
					? owner
					: null,
		connections: () => [activeConnection],
		invokeConnection: async ({ request }) => {
			const id = request.headers.get("cookie") ?? "";
			calls.push(id);
			return { owner: id };
		},
		spacesDatabase: {
			ensureForSite: async () => ({ spaceId: "space", databaseId: "db" }),
			query: async () => ({
				columns: [],
				rows: [],
				schema: [],
				truncated: false,
			}),
			records: async (_binding, id, collection, key) =>
				[...records.entries()]
					.filter(([recordKey]) => recordKey.startsWith(`${id}:${collection}:`))
					.map(([, record]) => record)
					.filter((record) => key === null || key === record.key),
			saveRecord: async (_binding, record) => {
				records.set(`${record.owner}:${record.collection}:${record.key}`, {
					key: record.key,
					value: JSON.parse(record.value),
				});
			},
			deleteRecord: async (_binding, id, collection, key) =>
				records.delete(`${id}:${collection}:${key}`),
			count: async () => records.size,
			ownerUsage: async () => [],
			ownerRecords: async () => [],
			deleteOwnerRecords: async () => 0,
			importRecords: async () => {},
			deleteDatabase: async () => {},
		},
	},
});
afterAll(() => {
	server.stop();
	store.close();
});
const origin = `http://todo-tools.localhost:${server.visitor.port}`;
async function visitor(
	path: string,
	method = "GET",
	value?: SiteDataValue,
	user = "reader",
	extra: Record<string, string> = {}
) {
	return (() => {
		const target = `http://127.0.0.1:${server.visitor.port}${path}`;
		const options = {
			method,
			headers: {
				host: `todo-tools.localhost:${server.visitor.port}`,
				cookie: user,
				origin,
				"content-type": "application/json",
				...extra,
			},
			body: value === undefined ? undefined : JSON.stringify(value),
			redirect: "manual",
		} satisfies RequestInit;
		return fetch(target, options);
	})();
}
async function rpc(name: string, args: SiteDataValue, user = "reader") {
	const response = await visitor(
		"/mcp",
		"POST",
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		},
		"",
		{ authorization: `Bearer ${user}` }
	);
	return response.json();
}
test("MCP requires a separate bearer identity and returns its OAuth resource metadata", async () => {
	expect((await visitor("/mcp", "POST", {})).status).toBe(401);
	const metadata = await visitor(
		"/.well-known/oauth-protected-resource",
		"GET",
		undefined,
		""
	);
	expect((await metadata.json()).authorization_servers).toEqual([
		"https://identity.example.com",
	]);
	const response = await visitor(
		"/mcp",
		"POST",
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			},
		},
		"",
		{ authorization: "Bearer reader" }
	);
	expect((await response.json()).result.capabilities.tools).toEqual({});
});
test("hosted MCP and website share records while isolating each user's data", async () => {
	expect(
		(await rpc("save_todo", { key: "first", value: { text: "Ship Sites" } }))
			.result.isError
	).toBeUndefined();
	const data = await visitor("/_ryu/records/todos/first");
	expect(await data.json()).toEqual([
		{ key: "first", value: { text: "Ship Sites" } },
	]);
	expect(
		(await rpc("list_todos", {}, "owner")).result.structuredContent.result
	).toEqual([]);
	expect(
		(await rpc("save_todo", { key: "first", value: "bad", userId: "owner" }))
			.error.code
	).toBe(-32_602);
	expect((await rpc("unknown_tool", {})).error.code).toBe(-32_602);
});
test("plugin is a native manifest with stable ID and no credentials", async () => {
	const response = await visitor("/_ryu/manifest.json");
	const manifest = await response.json();
	expect(manifest.id).toBe(`com.local.sites.site-${site.id}`);
	expect(manifest.mcp_servers.site).toEqual({
		type: "streamable-http",
		url: `http://127.0.0.1:${server.visitor.port}/sites/${site.id}/mcp`,
		auth: { type: "oauth" },
	});
	expect(JSON.stringify(manifest)).not.toContain("test-only-app-token");
});
test("connection consent requires trusted user navigation, binds the visitor, and revokes", async () => {
	const revision = connectionRevision(connection);
	const invoke = {
		action: "invoke",
		connectionId: connection.id,
		revision,
		arguments: {},
	};
	expect((await visitor("/_ryu/connections", "POST", invoke)).status).toBe(403);
	expect(
		(await visitor("/_ryu/connections", "POST", { ...invoke, action: "allow" }))
			.status
	).toBe(400);
	expect(
		(await visitor("/_ryu/connections/consent?connectionId=issues")).status
	).toBe(403);
	const navigation = {
		"sec-fetch-mode": "navigate",
		"sec-fetch-dest": "document",
		"sec-fetch-user": "?1",
	};
	const page = await visitor(
		"/_ryu/connections/consent?connectionId=issues",
		"GET",
		undefined,
		"reader",
		navigation
	);
	const html = await page.text();
	const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
	expect(ticket).toBeDefined();
	const consent = await (() => {
		const target = `http://127.0.0.1:${server.visitor.port}/_ryu/connections/consent`;
		const options = {
			method: "POST",
			headers: {
				host: `todo-tools.localhost:${server.visitor.port}`,
				cookie: "reader",
				origin,
				"content-type": "application/x-www-form-urlencoded",
				...navigation,
			},
			body: new URLSearchParams({ ticket: ticket ?? "", decision: "allow" }),
			redirect: "manual",
		} satisfies RequestInit;
		return fetch(target, options);
	})();
	expect(consent.status).toBe(303);
	expect(
		(await (await visitor("/_ryu/connections", "POST", invoke)).json()).result
	).toEqual({ owner: "reader" });
	expect(
		(await visitor("/_ryu/connections", "POST", invoke, "owner")).status
	).toBe(403);
	activeConnection = { ...connection, readOnly: false };
	expect((await visitor("/_ryu/connections", "POST", invoke)).status).toBe(409);
	activeConnection = connection;
	expect(
		(
			await visitor("/_ryu/connections", "POST", {
				...invoke,
				action: "revoke",
			})
		).status
	).toBe(200);
	expect((await visitor("/_ryu/connections", "POST", invoke)).status).toBe(403);
	expect(calls).toEqual(["reader"]);
});
test("the platform adapter forwards only the visitor JWT and operator-selected tool", async () => {
	let headers: Headers | undefined;
	let body: unknown;
	const adapter = createSitesConnections({
		corePort: 8000,
		token: "app",
		bindings: () => ({ [site.id]: [connection] }),
		userJwt: async () => "visitor-jwt",
		fetchImpl: Object.assign(
			async (
				_url: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1]
			) => {
				headers = new Headers(init?.headers);
				body = JSON.parse(String(init?.body));
				return Response.json({ ok: true, output: { done: true } });
			},
			{ preconnect: fetch.preconnect }
		),
	});
	expect(
		await adapter.invokeConnection({
			request: new Request(origin),
			connection,
			arguments: {},
		})
	).toEqual({ done: true });
	expect(headers?.get("x-ryu-user-jwt")).toBe("visitor-jwt");
	expect(body).toEqual({ tool: "tracker.list", agentId: "ryu", arguments: {} });
});
test("older settings default to disabled extensions", () => {
	expect(siteExtensions.parse(undefined)).toEqual({
		mcp: false,
		ui: false,
		tools: [],
		connections: [],
	});
});

/**
 * The native manifest fields this generator emits, as Core's loader requires
 * them. The satellite repository has no `packages/sdk`, so this standalone
 * schema runs everywhere; the canonical SDK schema is added in the monorepo.
 */
const generatedPluginManifest = z
	.object({
		id: z.string().regex(/^com\.local\.sites\.site-[a-z0-9-]+$/),
		name: z.string().min(1),
		version: z.string().regex(/^\d+\.\d+\.\d+$/),
		description: z.string().min(1),
		engines: z.object({ ryu: z.string().min(1) }).strict(),
		permission_grants: z.array(z.string().min(1)),
		mcp_servers: z
			.object({
				site: z
					.object({
						type: z.literal("streamable-http"),
						url: z.url(),
						auth: z.object({ type: z.literal("oauth") }).strict(),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
const monorepoSdkManifest = fileURLToPath(
	new URL("../../../../packages/sdk/src/manifest.ts", import.meta.url)
);
const canonicalManifestSchema = z.object({
	PluginManifestSchema: z.custom<{ parse: (value: unknown) => unknown }>(
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"parse" in value &&
			typeof value.parse === "function"
	),
});

test("generated Site plugin conforms to the native manifest schema", async () => {
	const manifest = sitePlugin(store.get(site.id), origin);
	expect(generatedPluginManifest.parse(manifest).id).toBe(
		`com.local.sites.site-${site.id}`
	);
	if (existsSync(monorepoSdkManifest)) {
		const { PluginManifestSchema } = canonicalManifestSchema.parse(
			await import(monorepoSdkManifest)
		);
		expect(PluginManifestSchema.parse(manifest)).toMatchObject({
			id: `com.local.sites.site-${site.id}`,
		});
	}
});

test("Site MCP Apps resources are versioned, credential-free, and shared without caching identity", async () => {
	const call = async (
		method: string,
		params?: SiteDataValue,
		user = "reader"
	) => {
		const response = await visitor(
			"/mcp",
			"POST",
			{ jsonrpc: "2.0", id: 1, method, params },
			"",
			{ authorization: `Bearer ${user}` }
		);
		return response.json();
	};
	const tools = await call("tools/list");
	const uri = tools.result.tools[0]._meta.ui.resourceUri;
	expect(uri).toStartWith(`ui://sites/${site.id}/version-1/`);
	expect(tools.result.tools[0]._meta["openai/ui"].entrypoints).toEqual([
		{ type: "global" },
		{ type: "thread" },
	]);
	const first = await call("resources/read", { uri });
	const second = await call("resources/read", { uri }, "owner");
	expect(first.result.contents[0].text).toBe(second.result.contents[0].text);
	expect(first.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
	expect(first.result.contents[0].text).not.toContain(reader.email);
	expect(first.result.contents[0].text).not.toContain("test-only-app-token");
	expect(
		(await call("resources/read", { uri: "ui://other-site" })).error.code
	).toBe(-32_602);
	expect(
		(await call("tools/call", { name: "ryu_site_context", arguments: {} }))
			.result.structuredContent.result.identity
	).toEqual({ id: reader.id, email: reader.email });
	const negotiated = await call("initialize", {
		protocolVersion: "2026-07-28",
		capabilities: {},
		clientInfo: { name: "future-client", version: "1" },
	});
	expect(negotiated.result.protocolVersion).toBe("2025-11-25");
});
