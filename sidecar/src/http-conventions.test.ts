import { afterAll, describe, expect, test } from "bun:test";
import {
	acceptsProblemJson,
	errorResponse,
	managementChallenge,
	newRequestId,
	PROBLEM_JSON_CONTENT_TYPE,
	SITES_PROBLEM_TYPE,
	statusTitle,
	withHeaders,
} from "./http-conventions.ts";
import { createVisitorRateLimiter, rateLimitHeaders } from "./rate-limit.ts";
import { ADMIN_MAX_REQUEST_BODY_BYTES, createSitesServer } from "./server.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";

const REQUEST_ID = /^req_[0-9a-f]{32}$/;

describe("problem details negotiation", () => {
	test("only a named application/problem+json with q>0 negotiates", () => {
		expect(acceptsProblemJson(null)).toBe(false);
		expect(acceptsProblemJson("*/*")).toBe(false);
		expect(acceptsProblemJson("application/json")).toBe(false);
		expect(acceptsProblemJson("application/*")).toBe(false);
		expect(acceptsProblemJson("application/problem+json")).toBe(true);
		expect(
			acceptsProblemJson("application/json, Application/Problem+JSON;q=0.5")
		).toBe(true);
		expect(acceptsProblemJson("application/problem+json;q=0")).toBe(false);
	});

	test("titles and types follow the status and code", () => {
		expect(statusTitle(413)).toBe("Content Too Large");
		expect(statusTitle(418)).toBe("Client Error");
		expect(statusTitle(599)).toBe("Server Error");
		// The page documents codes in one section; it has no per-code anchors.
		expect(SITES_PROBLEM_TYPE).toBe(
			"https://docs.ryuhq.com/docs/standalone/sites-api#revisions-and-errors"
		);
	});

	test("the legacy body is unchanged unless problem+json is asked for", async () => {
		const response = errorResponse(
			{ code: "invalid_input", message: "Check", fields: ["slug"] },
			400,
			{
				request: new Request("http://sites.test/api/sites/projects"),
				requestId: "req_1",
			}
		);
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("vary")).toBe("Accept");
		expect(response.headers.get("x-request-id")).toBe("req_1");
		expect(await response.json()).toEqual({
			error: { code: "invalid_input", message: "Check", fields: ["slug"] },
		});
	});

	test("the problem form keeps the legacy error member", async () => {
		const response = errorResponse(
			{ code: "too_large", message: "Request exceeds the size limit" },
			413,
			{
				request: new Request("http://sites.test/api/sites/projects", {
					headers: { accept: PROBLEM_JSON_CONTENT_TYPE },
				}),
				requestId: "req_2",
				headers: { "x-extra": "1" },
			}
		);
		expect(response.headers.get("content-type")).toBe(
			PROBLEM_JSON_CONTENT_TYPE
		);
		expect(response.headers.get("x-extra")).toBe("1");
		expect(await response.json()).toEqual({
			type: SITES_PROBLEM_TYPE,
			title: "Content Too Large",
			status: 413,
			detail: "Request exceeds the size limit",
			instance: "/api/sites/projects",
			code: "too_large",
			docs: SITES_PROBLEM_TYPE,
			requestId: "req_2",
			error: { code: "too_large", message: "Request exceeds the size limit" },
		});
	});

	test("challenges say whether a credential was rejected", () => {
		expect(managementChallenge(new Request("http://sites.test/"))).toBe(
			'Bearer realm="ryu-sites"'
		);
		expect(
			managementChallenge(
				new Request("http://sites.test/", {
					headers: { authorization: "Bearer wrong" },
				})
			)
		).toBe('Bearer realm="ryu-sites", error="invalid_token"');
		// RFC 6750 §3.1: `invalid_token` is only for a presented bearer token.
		for (const authorization of [
			"Basic dXNlcjpwYXNz",
			"Bearer",
			"Bearer   ",
			"Token abc",
		]) {
			expect({
				authorization,
				challenge: managementChallenge(
					new Request("http://sites.test/", { headers: { authorization } })
				),
			}).toEqual({ authorization, challenge: 'Bearer realm="ryu-sites"' });
		}
		expect(
			managementChallenge(
				new Request("http://sites.test/", {
					headers: { authorization: "bearer wrong" },
				})
			)
		).toBe('Bearer realm="ryu-sites", error="invalid_token"');
	});

	test("request ids are fresh and well formed", () => {
		const first = newRequestId();
		expect(first).toMatch(REQUEST_ID);
		expect(newRequestId()).not.toBe(first);
	});

	test("headers are set even on an immutable response", () => {
		const redirect = withHeaders(
			Response.redirect("http://sites.test/next", 308),
			{ "x-request-id": "req_3" }
		);
		expect(redirect.status).toBe(308);
		expect(redirect.headers.get("x-request-id")).toBe("req_3");
		expect(redirect.headers.get("location")).toBe("http://sites.test/next");
	});
});

describe("visitor rate-limit decisions", () => {
	test("a refusal names the exhausted budget and the window reset", () => {
		let clock = 15_250;
		const limiter = createVisitorRateLimiter({
			now: () => clock,
			siteLimit: 3,
			visitorLimit: 2,
		});
		expect(limiter.check("site", "a")).toEqual({ allowed: true });
		expect(limiter.check("site", "a")).toEqual({ allowed: true });
		expect(limiter.check("site", "a")).toEqual({
			allowed: false,
			policy: "visitor",
			limit: 2,
			retryAfter: 45,
		});
		expect(limiter.check("site", "b")).toEqual({ allowed: true });
		clock = 59_999;
		expect(limiter.check("site", "c")).toEqual({
			allowed: false,
			policy: "site",
			limit: 3,
			retryAfter: 1,
		});
		expect(limiter.policies).toEqual({ visitor: 2, site: 3 });
	});

	test("the refusal is described with the IETF RateLimit fields", () => {
		expect(
			rateLimitHeaders(
				{ allowed: false, policy: "visitor", limit: 120, retryAfter: 42 },
				{ visitor: 120, site: 6000 }
			)
		).toEqual({
			"retry-after": "42",
			ratelimit: '"visitor";r=0;t=42',
			"ratelimit-policy": '"visitor";q=120;w=60, "site";q=6000;w=60',
		});
	});
});

describe("Sites server conventions", () => {
	const store = new SitesStore(":memory:");
	const server = createSitesServer({
		store,
		token: "owner-test-token",
		port: 0,
		visitorPort: 0,
		mode: "standalone",
		publicEnabled: true,
		services: { scanArtifact: async () => ({ allowed: true, reason: null }) },
	});
	afterAll(() => {
		server.stop();
		store.close();
	});
	const admin = (
		path: string,
		init: { body?: string; headers?: Record<string, string>; method?: string }
	) =>
		fetch(`http://127.0.0.1:${server.admin.port}${path}`, {
			method: init.method ?? "GET",
			headers: init.headers,
			body: init.body,
		});
	const owner = {
		authorization: "Bearer owner-test-token",
		"content-type": "application/json",
	};

	test("a management 401 carries a challenge and a request id", async () => {
		const anonymous = await admin("/api/sites/projects", {});
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("www-authenticate")).toBe(
			'Bearer realm="ryu-sites"'
		);
		expect(anonymous.headers.get("x-request-id")).toMatch(REQUEST_ID);
		expect(await anonymous.json()).toEqual({
			error: { code: "unauthorized", message: "Sign in to manage Sites" },
		});
		const wrong = await admin("/api/sites/projects", {
			headers: { authorization: "Bearer wrong" },
		});
		expect(wrong.headers.get("www-authenticate")).toBe(
			'Bearer realm="ryu-sites", error="invalid_token"'
		);
	});

	test("successful management responses carry a request id, and no challenge", async () => {
		const health = await admin("/health", {});
		expect(health.headers.get("x-request-id")).toMatch(REQUEST_ID);
		const listed = await admin("/api/sites/projects", { headers: owner });
		expect(listed.status).toBe(200);
		expect(listed.headers.get("x-request-id")).toMatch(REQUEST_ID);
		expect(listed.headers.has("www-authenticate")).toBe(false);
	});

	test("an oversized management body gets Sites's own too_large problem", async () => {
		// Larger than the 2_100_000-byte route limit, below the listener's cap,
		// so the listener does not answer first with an empty 413.
		const html = "x".repeat(2_150_000);
		expect(html.length).toBeLessThan(ADMIN_MAX_REQUEST_BODY_BYTES);
		const tooLarge = await admin("/api/sites/projects", {
			method: "POST",
			headers: { ...owner, accept: PROBLEM_JSON_CONTENT_TYPE },
			body: JSON.stringify({ name: "Big", slug: "big-site", html }),
		});
		expect(tooLarge.status).toBe(413);
		expect(tooLarge.headers.get("content-type")).toBe(
			PROBLEM_JSON_CONTENT_TYPE
		);
		const requestId = tooLarge.headers.get("x-request-id");
		expect(requestId).toMatch(REQUEST_ID);
		expect(await tooLarge.json()).toMatchObject({
			status: 413,
			title: "Content Too Large",
			code: "too_large",
			requestId,
			error: { code: "too_large" },
		});
	});

	test("errors negotiate problem details by Accept", async () => {
		const problem = await admin("/api/sites/projects", {
			method: "POST",
			headers: { ...owner, accept: PROBLEM_JSON_CONTENT_TYPE },
			body: JSON.stringify({ name: "", slug: "x" }),
		});
		expect(problem.status).toBe(400);
		expect(problem.headers.get("content-type")).toBe(PROBLEM_JSON_CONTENT_TYPE);
		const requestId = problem.headers.get("x-request-id");
		const body = await problem.json();
		expect(body).toMatchObject({
			type: SITES_PROBLEM_TYPE,
			title: "Bad Request",
			status: 400,
			code: "invalid_input",
			instance: "/api/sites/projects",
			requestId,
			error: { code: "invalid_input", message: "Check the submitted fields" },
		});
		expect(body.error.fields).toContain("slug");
		const unsupported = await admin("/api/sites/projects", {
			method: "POST",
			headers: {
				authorization: owner.authorization,
				"content-type": "text/plain",
				accept: PROBLEM_JSON_CONTENT_TYPE,
			},
			body: "hello",
		});
		expect(unsupported.status).toBe(415);
		expect(await unsupported.json()).toMatchObject({
			title: "Unsupported Media Type",
			code: "invalid_input",
		});
	});

	test("a visitor 429 carries Retry-After and the RateLimit fields", async () => {
		const created = await admin("/api/sites/projects", {
			method: "POST",
			headers: owner,
			body: JSON.stringify({ name: "Limits", slug: "limits-site" }),
		});
		let site = runtimeSiteSchema.parse(await created.json());
		for (const step of [
			() =>
				admin(`/api/sites/projects/${site.id}/versions`, {
					method: "POST",
					headers: owner,
					body: JSON.stringify({
						html: starterHtml("Limits", "website", ""),
						expectedRevision: site.revision,
					}),
				}),
			() =>
				admin(`/api/sites/projects/${site.id}/deploy`, {
					method: "POST",
					headers: owner,
					body: JSON.stringify({
						versionId: site.versions.at(-1)?.id,
						expectedRevision: site.revision,
					}),
				}),
			() =>
				admin(`/api/sites/projects/${site.id}/settings`, {
					method: "PUT",
					headers: owner,
					body: JSON.stringify({
						settings: { ...site.settings, audience: "public" },
						expectedRevision: site.revision,
					}),
				}),
		]) {
			const response = await step();
			expect(response.ok).toBe(true);
			site = runtimeSiteSchema.parse(await response.json());
		}
		const visit = () =>
			fetch(`http://127.0.0.1:${server.visitor.port}/`, {
				headers: {
					host: `${site.slug}.localhost:${server.visitor.port}`,
					accept: PROBLEM_JSON_CONTENT_TYPE,
				},
			});
		// Up to two windows' worth, in case the minute turns over mid-flood.
		let refused = await visit();
		for (let index = 0; index < 240 && refused.status === 200; index += 1) {
			expect(refused.headers.has("ratelimit")).toBe(false);
			refused = await visit();
		}
		expect(refused.status).toBe(429);
		const retryAfter = Number(refused.headers.get("retry-after"));
		expect(retryAfter).toBeGreaterThanOrEqual(1);
		expect(retryAfter).toBeLessThanOrEqual(60);
		expect(refused.headers.get("ratelimit")).toBe(
			`"visitor";r=0;t=${retryAfter}`
		);
		expect(refused.headers.get("ratelimit-policy")).toBe(
			'"visitor";q=120;w=60, "site";q=6000;w=60'
		);
		expect(await refused.json()).toMatchObject({
			status: 429,
			title: "Too Many Requests",
			code: "rate_limit",
			error: {
				code: "rate_limit",
				message: "Too many requests; retry shortly",
			},
		});
	});
});
