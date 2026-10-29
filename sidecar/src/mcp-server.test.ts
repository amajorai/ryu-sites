import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginDataDir } from "@ryu/sidecar-runtime";
import { z } from "zod";
import type { SitePrincipal } from "./contracts.ts";
import { INSTANCE_PROOF_PATH, randomInstanceValue } from "./instance-proof.ts";
import {
	callSitesTool,
	createSitesApi,
	createSitesMcpSession,
	createToolBudget,
	MANAGEMENT_ENDPOINT_FILE,
	removeManagementEndpoint,
	resolveManagementEndpoint,
	SITES_MCP_LIMITS,
	sitesTools,
	writeManagementEndpoint,
} from "./mcp-server.ts";
import {
	AGENT_AUDIT_ACTION,
	createSitesServer,
	type SitesServices,
} from "./server.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";

const TOKEN = "owner-test-token";
const cleanup: (() => void)[] = [];
const dataRoot = mkdtempSync(join(tmpdir(), "ryu-sites-mcp-"));
afterAll(() => {
	for (const close of cleanup.splice(0)) {
		close();
	}
	rmSync(dataRoot, { recursive: true, force: true });
});

function harness(services: SitesServices = {}, publicEnabled = true) {
	const store = new SitesStore(":memory:");
	const secret = randomInstanceValue();
	const server = createSitesServer({
		store,
		instanceSecret: secret,
		token: TOKEN,
		port: 0,
		visitorPort: 0,
		publicEnabled,
		services: {
			scanArtifact: async () => ({ allowed: true, reason: null }),
			...services,
		},
	});
	cleanup.push(() => {
		server.stop();
		store.close();
	});
	const requests: string[] = [];
	const api = (token = TOKEN) =>
		createSitesApi({
			endpoint: () => ({
				baseUrl: `http://127.0.0.1:${server.admin.port}`,
				secret,
			}),
			token,
			fetch: (url, init) => {
				requests.push(`${init.method ?? "GET"} ${url}`);
				return fetch(url, init);
			},
		});
	return { store, server, api, requests, secret };
}

const resultSchema = z.object({
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	isError: z.boolean(),
});
const toolError = z.object({
	error: z.object({ code: z.string(), message: z.string() }),
});
const siteResult = z
	.object({
		id: z.string(),
		revision: z.number(),
		url: z.string(),
		audience: z.string(),
		visibility: z.string(),
		latestVersionId: z.string().nullable(),
		deployment: z.object({ versionId: z.string() }).nullable(),
	})
	.loose();

async function call(
	api: ReturnType<ReturnType<typeof harness>["api"]>,
	name: string,
	args: Record<string, unknown>,
	budget = createToolBudget()
) {
	const result = resultSchema.parse(
		await callSitesTool(api, budget, name, args)
	);
	return {
		isError: result.isError,
		value: JSON.parse(result.content[0]?.text ?? "null") as unknown,
	};
}
async function ok<T>(
	schema: z.ZodType<T>,
	pending: Promise<{ isError: boolean; value: unknown }>
) {
	const result = await pending;
	if (result.isError) {
		throw new Error(JSON.stringify(result.value));
	}
	return schema.parse(result.value);
}
async function failure(pending: Promise<{ isError: boolean; value: unknown }>) {
	const result = await pending;
	if (!result.isError) {
		throw new Error(
			`Expected a tool error, got ${JSON.stringify(result.value)}`
		);
	}
	return toolError.parse(result.value).error;
}
const created = z.object({ site: siteResult });
const saved = z.object({
	site: siteResult,
	version: z.object({ id: z.string() }),
	security: z.object({ status: z.string(), summary: z.string() }),
	deployed: z.literal(false),
});

async function createSite(h: ReturnType<typeof harness>, slug = "agent-site") {
	return (
		await ok(
			created,
			call(h.api(), "sites_create", {
				name: "Incident dashboard",
				slug,
				template: "dashboard",
				description: "Live incident overview",
			})
		)
	).site;
}

describe("Sites MCP protocol", () => {
	test("lists every tool with a JSON input schema", async () => {
		const tools = sitesTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"sites_list",
			"sites_get",
			"sites_get_source",
			"sites_create",
			"sites_save_version",
			"sites_deploy",
			"sites_set_access",
		]);
		for (const tool of tools) {
			expect(tool.inputSchema).toMatchObject({ type: "object" });
			expect("$schema" in tool.inputSchema).toBe(false);
			expect(tool.description.length).toBeGreaterThan(20);
		}
		expect(
			tools.find((tool) => tool.name === "sites_save_version")?.inputSchema
		).toMatchObject({
			required: ["siteId", "html", "expectedRevision"],
		});
	});

	test("serves legacy and modern handshakes and refuses bad frames", async () => {
		const h = harness();
		const session = createSitesMcpSession(h.api());
		expect(
			await session.handle({ jsonrpc: "2.0", method: "notifications/x" })
		).toBeNull();
		expect(
			await session.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
		).toMatchObject({ error: { code: -32_602 } });
		expect(
			await session.handle({
				jsonrpc: "2.0",
				id: 2,
				method: "initialize",
				params: {},
			})
		).toMatchObject({
			result: {
				protocolVersion: "2024-11-05",
				serverInfo: { name: "sites" },
			},
		});
		const listed = await session.handle({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/list",
		});
		expect(listed).toMatchObject({ result: { tools: sitesTools() } });
		const meta = {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientCapabilities": {},
		};
		expect(
			await session.handle({
				jsonrpc: "2.0",
				id: 4,
				method: "server/discover",
				params: { _meta: meta },
			})
		).toMatchObject({
			result: {
				resultType: "complete",
				supportedVersions: ["2026-07-28"],
			},
		});
		expect(
			await session.handle({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/list",
				params: {
					_meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1" },
				},
			})
		).toMatchObject({ error: { code: -32_022 } });
		expect(
			await session.handle({
				jsonrpc: "2.0",
				id: 6,
				method: "resources/list",
			})
		).toMatchObject({ error: { code: -32_601 } });
		const called = await session.handle({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "sites_list", arguments: {} },
		});
		expect(called).toMatchObject({ result: { isError: false } });
	});
});

describe("Sites MCP tools", () => {
	test("create, save, deploy and read a Site in one conversation", async () => {
		const h = harness();
		const site = await createSite(h);
		expect(site).toMatchObject({
			audience: "private",
			deployment: null,
			latestVersionId: null,
		});
		expect(site.url).toMatch(/^http:\/\/agent-site\.localhost:\d+\/$/);
		const html = starterHtml("Incidents", "dashboard", "");
		const first = await ok(
			saved,
			call(h.api(), "sites_save_version", {
				siteId: site.id,
				html: `\`\`\`html\n${html}\n\`\`\``,
				message: "First draft",
				expectedRevision: site.revision,
			})
		);
		expect(first.security.status).toBe("passed");
		expect(first.site.deployment).toBeNull();
		const source = await ok(
			z.object({ versionId: z.string(), html: z.string() }),
			call(h.api(), "sites_get_source", { siteId: site.id })
		);
		expect(source).toEqual({ versionId: first.version.id, html });
		const deployed = await ok(
			z.object({ site: siteResult, deployed: z.literal(true) }),
			call(h.api(), "sites_deploy", {
				siteId: site.id,
				versionId: first.version.id,
				expectedRevision: first.site.revision,
			})
		);
		expect(deployed.site.deployment?.versionId).toBe(first.version.id);
		const read = await ok(
			siteResult.extend({
				versions: z.array(
					z.object({ id: z.string(), deployed: z.boolean() }).loose()
				),
			}),
			call(h.api(), "sites_get", { siteId: site.id })
		);
		expect(read.versions).toEqual([
			expect.objectContaining({ id: first.version.id, deployed: true }),
		]);
		const listed = await ok(
			z.object({ sites: z.array(siteResult) }),
			call(h.api(), "sites_list", {})
		);
		expect(listed.sites.map((entry) => entry.id)).toEqual([site.id]);
		const visitor = await fetch(`http://127.0.0.1:${h.server.visitor.port}/`, {
			headers: { host: `agent-site.localhost:${h.server.visitor.port}` },
		});
		// Private by default: deploying never widens who can open the Site.
		expect(visitor.status).not.toBe(200);
		const shared = await ok(
			z.object({ site: siteResult }),
			call(h.api(), "sites_set_access", {
				siteId: site.id,
				audience: "public",
				expectedRevision: deployed.site.revision,
			})
		);
		expect(shared.site.audience).toBe("public");
		expect(shared.site.visibility).toContain("anyone");
	});

	test("records agent mutations in the Site audit with the verified actor", async () => {
		const h = harness();
		const site = await createSite(h);
		await ok(
			saved,
			call(h.api(), "sites_save_version", {
				siteId: site.id,
				html: starterHtml("Audit", "website", ""),
				expectedRevision: site.revision,
			})
		);
		const rows = z
			.array(z.object({ actor: z.string(), subject: z.string() }))
			.parse(
				h.store.db
					.query(
						"SELECT actor, subject FROM site_audit WHERE site=? AND action=? ORDER BY rowid"
					)
					.all(site.id, AGENT_AUDIT_ACTION)
			);
		expect(rows).toEqual([
			{ actor: "node-owner", subject: "create" },
			{ actor: "node-owner", subject: "versions" },
		]);
		// A Companion hop is not labelled as an agent action.
		const current = h.store.get(site.id);
		await fetch(
			`http://127.0.0.1:${h.server.admin.port}/api/sites/projects/${site.id}/name`,
			{
				method: "PUT",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					name: "Renamed",
					expectedRevision: current.revision,
				}),
			}
		);
		expect(
			h.store.db
				.query("SELECT COUNT(*) AS count FROM site_audit WHERE site=?")
				.get(site.id)
		).toEqual({ count: 2 });
	});

	test("validates HTML before it reaches the service", async () => {
		const h = harness();
		const site = await createSite(h);
		const before = h.requests.length;
		expect(
			await failure(
				call(h.api(), "sites_save_version", {
					siteId: site.id,
					html: "<html><body>No doctype</body></html>",
					expectedRevision: site.revision,
				})
			)
		).toMatchObject({ code: "incompatible" });
		expect(
			await failure(
				call(h.api(), "sites_save_version", {
					siteId: site.id,
					html: `<!doctype html>${"é".repeat(1_000_000)}`,
					expectedRevision: site.revision,
				})
			)
		).toMatchObject({ code: "quota" });
		expect(
			await failure(call(h.api(), "sites_get", { siteId: "../status" }))
		).toMatchObject({ code: "invalid_input" });
		expect(h.requests.length).toBe(before);
	});

	test("refuses stale revisions and blocked secret scans", async () => {
		const h = harness({
			scanArtifact: async (html) => ({
				allowed: !html.includes("sk-live"),
				reason: null,
			}),
		});
		const site = await createSite(h);
		const blocked = await ok(
			saved,
			call(h.api(), "sites_save_version", {
				siteId: site.id,
				html: "<!doctype html><p>sk-live-secret</p>",
				expectedRevision: site.revision,
			})
		);
		expect(blocked.security.status).toBe("blocked");
		expect(
			await failure(
				call(h.api(), "sites_save_version", {
					siteId: site.id,
					html: "<!doctype html><p>again</p>",
					expectedRevision: site.revision,
				})
			)
		).toMatchObject({ code: "conflict" });
		expect(
			await failure(
				call(h.api(), "sites_deploy", {
					siteId: site.id,
					versionId: blocked.version.id,
					expectedRevision: blocked.site.revision,
				})
			)
		).toMatchObject({ code: "security_blocked" });
		expect(h.store.get(site.id).deploymentId).toBeNull();
	});

	test("enforces the operator and identity policy on access changes", async () => {
		const h = harness({}, false);
		const site = await createSite(h);
		expect(
			await failure(
				call(h.api(), "sites_set_access", {
					siteId: site.id,
					audience: "public",
					expectedRevision: site.revision,
				})
			)
		).toMatchObject({ code: "policy_denied" });
		expect(
			await failure(
				call(h.api(), "sites_set_access", {
					siteId: site.id,
					audience: "invited",
					viewers: ["Friend@example.com"],
					expectedRevision: site.revision,
				})
			)
		).toMatchObject({ code: "unavailable" });
		expect(h.store.get(site.id).settings.audience).toBe("private");
	});

	test("acts only as the caller the sidecar verifies", async () => {
		let principal: SitePrincipal = {
			id: "alice",
			email: "alice@example.com",
			workspaceIds: [],
		};
		const h = harness({ managementIdentity: async () => principal });
		const site = await createSite(h);
		principal = { id: "bob", email: "bob@example.com", workspaceIds: [] };
		expect(
			await failure(call(h.api(), "sites_get", { siteId: site.id }))
		).toMatchObject({ code: "forbidden" });
		expect(
			await failure(
				call(h.api(), "sites_save_version", {
					siteId: site.id,
					html: "<!doctype html><p>takeover</p>",
					expectedRevision: site.revision,
				})
			)
		).toMatchObject({ code: "forbidden" });
		expect(
			await ok(
				z.object({ sites: z.array(z.unknown()) }),
				call(h.api(), "sites_list", {})
			)
		).toEqual({ sites: [] });
		expect(
			await failure(call(h.api("wrong-token"), "sites_list", {}))
		).toMatchObject({ code: "unauthorized" });
		expect(h.store.get(site.id).versions).toEqual([]);
	});

	test("reports an unreachable service instead of an empty result", async () => {
		const api = createSitesApi({
			endpoint: () => ({
				baseUrl: "http://127.0.0.1:1",
				secret: randomInstanceValue(),
			}),
			token: TOKEN,
			fetch: () => Promise.reject(new Error("refused")),
		});
		expect(await failure(call(api, "sites_list", {}))).toMatchObject({
			code: "sites_unavailable",
		});
		expect(await failure(call(api, "sites_unknown", {}))).toMatchObject({
			code: "unknown_tool",
		});
	});

	test("bounds tool calls and writes per minute", async () => {
		let now = 0;
		const budget = createToolBudget(() => now);
		const api = { request: async () => [] };
		for (let index = 0; index < SITES_MCP_LIMITS.mutationsPerMinute; index++) {
			budget.take(true);
		}
		const limited = resultSchema.parse(
			await callSitesTool(api, budget, "sites_create", {})
		);
		expect(limited.isError).toBe(true);
		expect(limited.content[0]?.text).toContain("rate_limit");
		// Reads still have budget while writes are exhausted.
		expect(() => budget.take(false)).not.toThrow();
		now = 60_001;
		expect(() => budget.take(true)).not.toThrow();
	});
});

describe("Sites MCP process wiring", () => {
	test("finds the sidecar only through its recorded endpoint", () => {
		const env = {
			RYU_PROFILE: "dev",
			RYU_DIR: mkdtempSync(join(dataRoot, "d-")),
		};
		const directory = resolvePluginDataDir(env, "@ryu/sites");
		mkdirSync(directory, { recursive: true });
		// No profile-default fallback, and an explicit port carries no secret.
		expect(resolveManagementEndpoint(env)).toBeNull();
		expect(
			resolveManagementEndpoint({ ...env, RYU_SITES_PORT: "40001" })
		).toBeNull();
		const secret = randomInstanceValue();
		writeManagementEndpoint(directory, 43_210, secret);
		expect(resolveManagementEndpoint(env)).toEqual({
			baseUrl: "http://127.0.0.1:43210",
			secret,
		});
	});

	test("rewrites a pre-existing endpoint file as owner-only", () => {
		const directory = mkdtempSync(join(dataRoot, "m-"));
		const file = join(directory, MANAGEMENT_ENDPOINT_FILE);
		writeFileSync(file, JSON.stringify({ port: 1 }), { mode: 0o644 });
		const secret = randomInstanceValue();
		writeManagementEndpoint(directory, 43_211, secret);
		expect(statSync(file).mode % 0o1000).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			port: 43_211,
			secret,
		});
	});

	test("removes the endpoint file only for the process that wrote it", () => {
		const directory = mkdtempSync(join(dataRoot, "r-"));
		const file = join(directory, MANAGEMENT_ENDPOINT_FILE);
		const newer = randomInstanceValue();
		writeManagementEndpoint(directory, 43_212, newer);
		removeManagementEndpoint(directory, randomInstanceValue());
		expect(existsSync(file)).toBe(true);
		removeManagementEndpoint(directory, newer);
		expect(existsSync(file)).toBe(false);
	});

	test("refuses without a recorded endpoint and sends nothing", async () => {
		const requests: string[] = [];
		const api = createSitesApi({
			endpoint: () => null,
			token: TOKEN,
			fetch: (url) => {
				requests.push(url);
				return Promise.resolve(Response.json([]));
			},
		});
		expect(await failure(call(api, "sites_list", {}))).toMatchObject({
			code: "sites_unavailable",
		});
		expect(requests).toEqual([]);
	});

	test("never sends the bearer to a listener that cannot prove the instance", async () => {
		const seen: { path: string; authorization: string | null }[] = [];
		const impostor = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				seen.push({
					path: new URL(request.url).pathname,
					authorization: request.headers.get("authorization"),
				});
				return Response.json({ proof: "0".repeat(64) });
			},
		});
		cleanup.push(() => impostor.stop(true));
		const api = createSitesApi({
			endpoint: () => ({
				baseUrl: `http://127.0.0.1:${impostor.port}`,
				secret: randomInstanceValue(),
			}),
			token: TOKEN,
		});
		expect(await failure(call(api, "sites_list", {}))).toMatchObject({
			code: "sites_unavailable",
		});
		expect(seen.length).toBeGreaterThan(0);
		for (const hit of seen) {
			expect(hit).toEqual({ path: INSTANCE_PROOF_PATH, authorization: null });
		}
	});

	test("refuses a real sidecar whose secret does not match the record", async () => {
		const h = harness();
		const api = createSitesApi({
			endpoint: () => ({
				baseUrl: `http://127.0.0.1:${h.server.admin.port}`,
				secret: randomInstanceValue(),
			}),
			token: TOKEN,
		});
		expect(await failure(call(api, "sites_list", {}))).toMatchObject({
			code: "sites_unavailable",
		});
	});

	test("instance proof route validates its challenge and needs a secret", async () => {
		const h = harness();
		const base = `http://127.0.0.1:${h.server.admin.port}${INSTANCE_PROOF_PATH}`;
		expect((await fetch(`${base}?challenge=short`)).status).toBe(400);
		expect(
			(
				await fetch(`${base}?challenge=${randomInstanceValue()}`, {
					method: "POST",
				})
			).status
		).toBe(404);
		const store = new SitesStore(":memory:");
		const bare = createSitesServer({
			store,
			token: TOKEN,
			port: 0,
			visitorPort: 0,
		});
		cleanup.push(() => {
			bare.stop();
			store.close();
		});
		expect(
			(
				await fetch(
					`http://127.0.0.1:${bare.admin.port}${INSTANCE_PROOF_PATH}?challenge=${randomInstanceValue()}`
				)
			).status
		).toBe(404);
	});

	test("`ryu-sites mcp` answers over stdio against the running sidecar", async () => {
		const h = harness();
		await createSite(h, "stdio-site");
		const env = {
			RYU_PROFILE: "dev",
			RYU_KEYCHAIN: "off",
			RYU_DIR: mkdtempSync(join(dataRoot, "p-")),
		};
		const directory = resolvePluginDataDir(env, "@ryu/sites");
		mkdirSync(directory, { recursive: true });
		writeManagementEndpoint(directory, h.server.admin.port, h.secret);
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "index.ts"), "mcp"],
			{
				env: { ...env, RYU_SITES_TOKEN: TOKEN },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const frames = [
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "sites_list", arguments: { scope: "owned" } },
			},
		];
		child.stdin.write(frames.map((frame) => JSON.stringify(frame)).join("\n"));
		child.stdin.write("\n");
		await child.stdin.end();
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		const lines = output
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as unknown);
		expect(lines[0]).toMatchObject({ id: 1, result: { serverInfo: {} } });
		expect(JSON.stringify(lines[1])).toContain("stdio-site");
	});
});
