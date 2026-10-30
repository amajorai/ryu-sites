import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SiteDataValue } from "./data-values.ts";
import { createSitesServer } from "./server.ts";
import {
	cleanup,
	create,
	deploy,
	harness,
	publish,
	runCleanup,
	save,
} from "./server-harness.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";

afterAll(runCleanup);

test("SQLite projects survive a process restart", () => {
	const directory = mkdtempSync(join(tmpdir(), "sites-store-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "sites.sqlite");
	const store = new SitesStore(path);
	const site = store.create(
		{ name: "Durable", slug: "durable-site" },
		{ id: "owner", email: "owner@example.com", workspaceIds: [] }
	);
	store.close();
	const reopened = new SitesStore(path);
	expect(reopened.get(site.id).slug).toBe("durable-site");
	reopened.close();
});

test("deployment scans the immutable artifact and never treats scanner failure as success", async () => {
	const scanned: string[] = [];
	const h = harness({
		scanArtifact: async (html) => {
			scanned.push(html);
			return {
				allowed: false,
				reason: "a sensitive value that must not be reflected",
			};
		},
	});
	let site = await create(h);
	const html = "<!doctype html><h1>Private draft</h1>";
	site = await save(h, site, html);
	const response = await h.admin(`/projects/${site.id}/deploy`, "POST", {
		versionId: site.versions[0]?.id,
		expectedRevision: site.revision,
	});
	expect(response.status).toBe(422);
	expect(await response.text()).not.toContain("sensitive value");
	expect(scanned).toEqual([html]);
	expect(h.store.get(site.id).deploymentId).toBeNull();
	const report = z
		.object({
			status: z.string(),
			artifactDigest: z.string(),
			protections: z.array(z.object({ name: z.string(), detail: z.string() })),
		})
		.parse(await (await h.admin(`/projects/${site.id}/security`)).json());
	expect(report.status).toBe("blocked");
	// The visitor CSP does not govern navigation or WebRTC, so the report must
	// not claim that every external connection is blocked.
	expect(
		report.protections.find(
			(protection) => protection.name === "Restricted browser capabilities"
		)?.detail
	).toContain("page navigation and some browser peer-connection features");
	expect(report.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
	const unavailable = harness({ scanArtifact: undefined });
	const saved = await save(
		unavailable,
		await create(unavailable, "scanner-off")
	);
	expect(
		(
			await unavailable.admin(`/projects/${saved.id}/deploy`, "POST", {
				versionId: saved.versions[0]?.id,
				expectedRevision: saved.revision,
			})
		).status
	).toBe(422);
});

test("turning public publishing off suspends Sites that are already public", async () => {
	const directory = mkdtempSync(join(tmpdir(), "sites-public-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "sites.sqlite");
	const start = (publicEnabled: boolean) => {
		const store = new SitesStore(path);
		const server = createSitesServer({
			store,
			token: "owner-test-token",
			port: 0,
			visitorPort: 0,
			publicEnabled,
			services: {
				scanArtifact: async () => ({ allowed: true, reason: null }),
				identity: async (request) =>
					request.headers.get("authorization") === "Bearer visitor"
						? { id: "visitor", email: "v@example.com", workspaceIds: [] }
						: null,
			},
		});
		const admin = (route: string, method = "GET", body?: SiteDataValue) =>
			fetch(`http://127.0.0.1:${server.admin.port}/api/sites${route}`, {
				method,
				headers: {
					authorization: "Bearer owner-test-token",
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const visit = (slug: string, route: string, auth?: string) =>
			fetch(`http://127.0.0.1:${server.visitor.port}${route}`, {
				headers: {
					host: `${slug}.localhost:${server.visitor.port}`,
					...(auth ? { authorization: auth } : {}),
				},
			});
		const stop = () => {
			server.stop();
			store.close();
		};
		return { admin, visit, server, stop };
	};
	const before = start(true);
	let site = runtimeSiteSchema.parse(
		await (
			await before.admin("/projects", "POST", {
				name: "Public site",
				slug: "public-site",
			})
		).json()
	);
	site = runtimeSiteSchema.parse(
		await (
			await before.admin(`/projects/${site.id}/versions`, "POST", {
				html: starterHtml("Public", "website", ""),
				expectedRevision: site.revision,
			})
		).json()
	);
	site = runtimeSiteSchema.parse(
		await (
			await before.admin(`/projects/${site.id}/deploy`, "POST", {
				versionId: site.versions.at(-1)?.id,
				expectedRevision: site.revision,
			})
		).json()
	);
	const published = await before.admin(`/projects/${site.id}/settings`, "PUT", {
		settings: { ...site.settings, audience: "public" },
		expectedRevision: site.revision,
	});
	expect(published.status).toBe(200);
	expect((await before.visit(site.slug, "/")).status).toBe(200);
	before.stop();

	const after = start(false);
	cleanup.push(after.stop);
	expect((await after.visit(site.slug, "/")).status).toBe(403);
	expect((await after.visit(site.slug, "/_ryu/config")).status).toBe(403);
	expect(
		(await after.visit(site.slug, "/_ryu/config", "Bearer visitor")).status
	).toBe(403);
	expect((await after.admin(`/projects/${site.id}`)).status).toBe(200);
});

describe("visitor rate limits behind an operator-trusted edge", () => {
	const flood = async (
		h: ReturnType<typeof harness>,
		slug: string,
		forwardedFor: string,
		count: number
	) => {
		const statuses: number[] = [];
		for (let index = 0; index < count; index += 1) {
			const response = await h.visitor(slug, "/", "GET", undefined, {
				"x-forwarded-for": forwardedFor,
				"user-agent": `agent-${index}`,
			});
			statuses.push(response.status);
		}
		return statuses;
	};

	test("distinct forwarded visitors get independent budgets and digests", async () => {
		const h = harness({}, true, ["127.0.0.1"]);
		const site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		const first = await flood(h, site.slug, "203.0.113.7", 121);
		expect(first.slice(0, 120).every((status) => status === 200)).toBe(true);
		expect(first[120]).toBe(429);
		expect(
			(
				await h.visitor(site.slug, "/", "GET", undefined, {
					"x-forwarded-for": "198.51.100.4",
				})
			).status
		).toBe(200);
		const report = await (
			await h.admin(`/projects/${site.id}/analytics?days=7`)
		).json();
		expect(report.summary.uniqueVisitors).toBe(121);
	});

	test("a client-prepended forwarded entry never selects the budget", async () => {
		const h = harness({}, true, ["127.0.0.0/8"]);
		const site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		await flood(h, site.slug, "203.0.113.7", 120);
		const spoofed = await h.visitor(site.slug, "/", "GET", undefined, {
			"x-forwarded-for": "192.0.2.55, 203.0.113.7",
		});
		expect(spoofed.status).toBe(429);
	});

	test("forwarded addresses are ignored without a trusted proxy list", async () => {
		const h = harness();
		const site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		await flood(h, site.slug, "203.0.113.7", 120);
		const other = await h.visitor(site.slug, "/", "GET", undefined, {
			"x-forwarded-for": "198.51.100.4",
		});
		expect(other.status).toBe(429);
	});
});
