/**
 * The Effect route tables: every declared route is reachable and does the
 * work (the `*` fallback alone serves no endpoint), unknown paths and wrong
 * methods keep the former envelopes, and neither the router's lenient
 * matching (case, slashes, HEAD) nor its decoding (malformed escapes, long
 * parameters) changes an answer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { effectWebHandler } from "@ryu/sidecar-runtime/effect-http";
import { HttpRouter } from "effect/http";
import { adminRoutes } from "./admin-routes.ts";
import type { SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createSitesContext } from "./server-context.ts";
import {
	create,
	deploy,
	harness,
	publish,
	runCleanup,
	save,
} from "./server-harness.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import { SitesStore } from "./store.ts";
import { visitorRoutes } from "./visitor-routes.ts";

afterAll(runCleanup);

const visitorUser: SitePrincipal = {
	id: "visitor-1",
	email: "visitor@example.com",
	workspaceIds: [],
};

/** The answers a route that is never reached would give. */
const UNROUTED = new Set([
	"Route not found",
	"Operation not found",
	"Resource not found",
]);

const table = (routes: readonly { method: string; path: string }[]) =>
	routes.map((route) => `${route.method} ${route.path}`);

async function messageOf(response: Response): Promise<string | null> {
	const text = await response.text();
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			parsed &&
			typeof parsed === "object" &&
			"error" in parsed &&
			parsed.error &&
			typeof parsed.error === "object" &&
			"message" in parsed.error &&
			typeof parsed.error.message === "string"
		) {
			return parsed.error.message;
		}
	} catch {
		// Not a Sites error body.
	}
	return null;
}

/** Requests answered by the `*` route alone, as if no other route existed. */
async function fallbackOnly(
	routes: readonly HttpRouter.Route<never>[],
	requests: readonly Request[]
): Promise<Response[]> {
	const fallback = routes.at(-1);
	if (!(fallback?.method === "*" && fallback.path === "*")) {
		throw new Error("the last route is not the * fallback");
	}
	const handler = effectWebHandler(HttpRouter.addAll([fallback]));
	try {
		const responses: Response[] = [];
		for (const request of requests) {
			responses.push(await handler.fetch(request));
		}
		return responses;
	} finally {
		await handler.dispose();
	}
}

/** A published, connected Site with records and uploads, plus its harness. */
async function connectedSite() {
	const h = harness({
		identity: async (request) =>
			request.headers.get("x-test-user") ? visitorUser : null,
	});
	let site = await publish(h, await deploy(h, await save(h, await create(h))));
	const connected = await h.admin(
		`/projects/${site.id}/database/connect`,
		"POST",
		{ expectedRevision: site.revision }
	);
	site = runtimeSiteSchema.parse(await connected.json());
	const settings = await h.admin(`/projects/${site.id}/settings`, "PUT", {
		expectedRevision: site.revision,
		settings: {
			...site.settings,
			mode: "connected",
			storage: true,
			uploads: true,
		},
	});
	if (settings.status !== 200) {
		throw new Error(await settings.text());
	}
	return { h, site: runtimeSiteSchema.parse(await settings.json()) };
}

describe("management route table", () => {
	const store = new SitesStore(":memory:");
	afterAll(() => store.close());
	const declared = (mode: "core" | "standalone") =>
		table(
			adminRoutes(createSitesContext({ store, token: "t", mode }, () => 0))
		);

	test("declares each endpoint with its real method, with and without /api/sites", () => {
		const routes = declared("core");
		expect(routes.slice(0, 2)).toEqual([
			"* /health",
			"* /api/sites/instance-proof",
		]);
		for (const prefix of ["", "/api/sites"]) {
			for (const route of [
				"GET /runtime",
				"GET /status",
				"GET /projects",
				"POST /projects",
				"POST /projects/:siteId/remix",
				"POST /projects/:siteId/install-plugin",
				"GET /projects/:siteId/extensions",
				"PUT /projects/:siteId/extensions",
				"GET /projects/:siteId/connections",
				"PUT /projects/:siteId/connections",
				"GET /projects/:siteId",
				"GET /projects/:siteId/security",
				"GET /projects/:siteId/versions/*",
				"POST /projects/:siteId/versions",
				"POST /projects/:siteId/deploy",
				"POST /projects/:siteId/reset",
				"PUT /projects/:siteId/settings",
				"POST /projects/:siteId/database/connect",
				"GET /projects/:siteId/database",
				"POST /projects/:siteId/database/query",
				"GET /projects/:siteId/visitors",
				"DELETE /projects/:siteId/visitors/:visitor/data",
				"PUT /projects/:siteId/name",
				"PUT /projects/:siteId/url",
				"POST /projects/:siteId/unpublish",
				"POST /projects/:siteId/domains",
				"POST /projects/:siteId/domains/check",
				"DELETE /projects/:siteId/domains",
				"GET /projects/:siteId/analytics",
				"DELETE /projects/:siteId",
			]) {
				const [method, path] = route.split(" ");
				expect(routes).toContain(`${method} ${prefix}${path}`);
			}
		}
		// The only catch-all is the final fallback.
		expect(routes.filter((route) => route.includes("*")).at(-1)).toBe("* *");
		expect(routes.filter((route) => route.endsWith(" *"))).toEqual(["* *"]);
		expect(routes).toHaveLength(2 + 2 * 30 + 1);
		// The standalone home is a route only in standalone mode.
		expect(routes).not.toContain("GET /");
		expect(declared("standalone")).toContain("GET /");
	});

	test("reaches every declared Site route", async () => {
		const { h, site } = await connectedSite();
		const version = site.versions.at(-1)?.id ?? "";
		const routes = declared("core").filter((route) =>
			route.includes(":siteId")
		);
		for (const route of routes) {
			const [method = "GET", path = "/"] = route.split(" ");
			const target = path
				.replace(/^\/api\/sites/, "")
				.replace(":siteId", site.id)
				.replace(":visitor", "dmlzaXRvcg")
				.replace("*", version);
			const response = await h.admin(
				target,
				method,
				method === "GET" ? undefined : ({} satisfies SiteDataValue)
			);
			expect(response.status, route).not.toBe(405);
			expect(UNROUTED.has((await messageOf(response)) ?? ""), route).toBe(
				false
			);
		}
	});

	test("keeps the former envelopes for unknown paths and wrong methods", async () => {
		const h = harness();
		const site = await create(h);
		const unknown = await h.admin("/nope");
		expect(unknown.status).toBe(404);
		expect(unknown.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{32}$/);
		expect(await unknown.json()).toEqual({
			error: { code: "not_found", message: "Route not found" },
		});
		for (const [method, path, message] of [
			["PATCH", "/status", "Route not found"],
			["PUT", "/projects", "Route not found"],
			["GET", "/STATUS", "Route not found"],
			["GET", "/status/", "Route not found"],
			["GET", "/projects/", "Route not found"],
			["PATCH", `/projects/${site.id}/deploy`, "Operation not found"],
			["GET", `/projects/${site.id}/DEPLOY`, "Operation not found"],
			["POST", `/projects/${site.id}/deploy/`, "Operation not found"],
			["HEAD", `/projects/${site.id}`, null],
		] as const) {
			const response = await h.admin(path, method);
			expect(response.status, `${method} ${path}`).toBe(404);
			if (message) {
				expect(await response.json()).toEqual({
					error: { code: "not_found", message },
				});
			}
		}
		// A request that does not sign in learns nothing about routes.
		const anonymous = await fetch(
			`http://127.0.0.1:${h.server.admin.port}/nope`
		);
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("www-authenticate")).toBe(
			'Bearer realm="ryu-sites"'
		);
	});

	test("the fallback alone serves no management endpoint", async () => {
		const { h, site } = await connectedSite();
		const context = createSitesContext(
			{ store: h.store, token: "owner-test-token" },
			() => 0
		);
		const bearer = { authorization: "Bearer owner-test-token" };
		const answers = await fallbackOnly(adminRoutes(context), [
			new Request("http://127.0.0.1/api/sites/status", { headers: bearer }),
			new Request("http://127.0.0.1/projects", { headers: bearer }),
			new Request(`http://127.0.0.1/api/sites/projects/${site.id}`, {
				headers: bearer,
			}),
			new Request(`http://127.0.0.1/projects/${site.id}/analytics`, {
				headers: bearer,
			}),
			new Request("http://127.0.0.1/health"),
		]);
		expect(await Promise.all(answers.map(messageOf))).toEqual([
			"Route not found",
			"Route not found",
			"Operation not found",
			"Operation not found",
			"Sign in to manage Sites",
		]);
	});

	test("routes malformed escapes and long parameters by their raw path", async () => {
		const { h, site } = await connectedSite();
		const port = h.server.admin.port;
		// The router cannot decode these paths; they still get Sites' answers.
		for (const path of ["/%ff", "/50%off", "/api/sites/%E0%A4%A"]) {
			const response = await fetch(`http://127.0.0.1:${port}${path}`);
			expect(response.status, path).toBe(401);
			expect(response.headers.get("www-authenticate")).toBe(
				'Bearer realm="ryu-sites"'
			);
			expect(response.headers.get("x-request-id")).toMatch(/^req_/);
			expect(await messageOf(response)).toBe("Sign in to manage Sites");
		}
		const version = await h.admin(`/projects/${site.id}/versions/50%off`);
		expect(version.status).toBe(404);
		expect(await messageOf(version)).toBe("Saved version not found");
		// A parameter past the router's 100 characters still reaches its route.
		const visitor = await h.admin(
			`/projects/${site.id}/visitors/${"v".repeat(120)}/data`,
			"DELETE"
		);
		expect(UNROUTED.has((await messageOf(visitor)) ?? "")).toBe(false);
		const semicolon = await h.admin(
			`/projects/${site.id};x/deploy`,
			"POST",
			{}
		);
		expect(await messageOf(semicolon)).toBe("Site not found");
	});

	test("answers HEAD with the length of the body it withholds", async () => {
		const h = harness();
		const health = await fetch(
			`http://127.0.0.1:${h.server.admin.port}/health`,
			{
				method: "HEAD",
			}
		);
		expect(health.status).toBe(200);
		expect(health.headers.get("content-length")).toBe(
			String(JSON.stringify({ ok: true }).length)
		);
		expect(await health.text()).toBe("");
	});
});

describe("visitor route table", () => {
	test("declares the visitor endpoints and one final fallback", () => {
		const store = new SitesStore(":memory:");
		const routes = table(
			visitorRoutes(createSitesContext({ store, token: "t" }, () => 0))
		);
		store.close();
		expect(routes).toEqual([
			"GET /_ryu/edge-ready",
			"* /mcp",
			"* /sites/:siteId/mcp",
			"* /.well-known/oauth-protected-resource",
			"* /.well-known/oauth-protected-resource/sites/:siteId/mcp",
			"GET /_ryu/runtime.js",
			"GET /_ryu/config",
			"GET /_ryu/identity",
			"GET /_ryu/manifest.json",
			"GET /_ryu/connections/consent",
			"GET /_ryu/connections",
			"POST /_ryu/connections/consent",
			"POST /_ryu/connections",
			"* /_ryu/shared/*",
			"POST /_ryu/reset",
			"POST /_ryu/ask",
			"POST /_ryu/complete",
			"POST /_ryu/search",
			"* /_ryu/records/*",
			"POST /_ryu/files",
			"* /_ryu/files/:fileId",
			"* *",
		]);
	});

	test("reaches every declared visitor endpoint on a Site host", async () => {
		const { h, site } = await connectedSite();
		const signedIn = { "x-test-user": "1" };
		for (const [method, path] of [
			["GET", "/_ryu/runtime.js"],
			["GET", "/_ryu/config"],
			["GET", "/_ryu/identity"],
			["GET", "/_ryu/connections/consent"],
			["POST", "/_ryu/connections"],
			["GET", "/_ryu/shared/notes"],
			["POST", "/_ryu/reset"],
			["POST", "/_ryu/ask"],
			["POST", "/_ryu/complete"],
			["POST", "/_ryu/search"],
			["PUT", "/_ryu/records/notes/one"],
			["POST", "/_ryu/files"],
			["GET", `/_ryu/files/${crypto.randomUUID()}`],
		] as const) {
			const response = await h.visitor(
				site.slug,
				path,
				method,
				method === "GET" ? undefined : {},
				signedIn
			);
			expect(response.status, `${method} ${path}`).not.toBe(405);
			expect(
				UNROUTED.has((await messageOf(response)) ?? ""),
				`${method} ${path}`
			).toBe(false);
		}
		const page = await h.visitor(site.slug, "/any/page");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const mcp = await h.visitor(site.slug, "/mcp", "POST", {});
		expect(mcp.status).toBe(401);
		const edge = await h.visitor("unbound", "/_ryu/edge-ready");
		expect(await edge.json()).toEqual({
			error: {
				code: "not_found",
				message: "Domain is not bound to a Site",
			},
		});
	});

	test("the fallback alone serves no visitor endpoint", async () => {
		const { h, site } = await connectedSite();
		const context = createSitesContext(
			{
				store: h.store,
				token: "owner-test-token",
				publicEnabled: true,
				services: {
					identity: async (request) =>
						request.headers.get("x-test-user") ? visitorUser : null,
				},
			},
			() => 0
		);
		const host = `${site.slug}.localhost`;
		const headers = { host, origin: `http://${host}`, "x-test-user": "1" };
		const answers = await fallbackOnly(
			visitorRoutes(context),
			["/_ryu/config", "/_ryu/runtime.js", "/_ryu/records/notes"].map(
				(path) => new Request(`http://${host}${path}`, { headers })
			)
		);
		for (const answer of answers) {
			expect(answer.status).toBe(404);
			expect(await messageOf(answer)).toBe("Resource not found");
		}
		const [mcp, edge] = await fallbackOnly(visitorRoutes(context), [
			new Request(`http://${host}/mcp`, { method: "POST", headers }),
			new Request("http://unbound.localhost/_ryu/edge-ready", {
				headers: { host: "unbound.localhost" },
			}),
		]);
		expect(mcp?.status).toBe(405);
		expect(await messageOf(edge ?? new Response())).toBe(
			"Site is not deployed"
		);
	});

	test("serves pages and endpoints whose paths the router cannot decode", async () => {
		const { h, site } = await connectedSite();
		const sale = await h.visitor(site.slug, "/sale/50%off");
		expect(sale.status).toBe(200);
		expect(sale.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(sale.headers.get("content-security-policy")).toContain(
			"default-src 'none'"
		);
		const file = await h.visitor(
			site.slug,
			"/_ryu/files/%ff",
			"GET",
			undefined,
			{
				"x-test-user": "1",
			}
		);
		expect(file.status).toBe(404);
	});

	test("keeps the former envelopes for unknown paths and wrong methods", async () => {
		const { h, site } = await connectedSite();
		const signedIn = { "x-test-user": "1" };
		const unknown = await h.visitor(
			site.slug,
			"/_ryu/nope",
			"GET",
			undefined,
			signedIn
		);
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({
			error: { code: "not_found", message: "Resource not found" },
		});
		const anonymous = await h.visitor(site.slug, "/_ryu/nope");
		expect(anonymous.status).toBe(401);
		const wrongMethod = await h.visitor(site.slug, "/about", "PUT", {});
		expect(wrongMethod.status).toBe(405);
		expect(await wrongMethod.json()).toEqual({
			error: { code: "method", message: "Method not allowed" },
		});
		// Exact, case-sensitive paths: `/_RYU/` is a page path, as before.
		const upper = await h.visitor(site.slug, "/_RYU/config");
		expect(upper.status).toBe(200);
		expect(upper.headers.get("content-type")).toBe("text/html; charset=utf-8");
		// A data route with the wrong method falls back to the same 404.
		const wrong = await h.visitor(site.slug, "/_ryu/ask", "PUT", {}, signedIn);
		expect(await wrong.json()).toEqual({
			error: { code: "not_found", message: "Resource not found" },
		});
		const head = await h.visitor(site.slug, "/", "HEAD");
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});
});
