import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import { createSitesServer, type SitesServices } from "./server.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";

const cleanup: (() => void)[] = [];
afterAll(() => {
	// Bun may run sibling tests concurrently. Cleaning this shared list after
	// each test lets one test stop another test's in-flight server.
	for (const close of cleanup.splice(0)) {
		close();
	}
});
function harness(services: SitesServices = {}, publicEnabled = true) {
	const store = new SitesStore(":memory:");
	const server = createSitesServer({
		store,
		token: "owner-test-token",
		port: 0,
		visitorPort: 0,
		services: {
			scanArtifact: async () => ({ allowed: true, reason: null }),
			...services,
		},
		publicEnabled,
	});
	cleanup.push(() => {
		server.stop();
		store.close();
	});
	const admin = (
		path: string,
		method = "GET",
		body?: unknown,
		token = "owner-test-token"
	) =>
		fetch(`http://127.0.0.1:${server.admin.port}/api/sites${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const visitor = (
		slug: string,
		path = "/",
		method = "GET",
		body?: unknown,
		extra: Record<string, string> = {}
	) =>
		fetch(`http://127.0.0.1:${server.visitor.port}${path}`, {
			method,
			headers: {
				host: `${slug}.localhost:${server.visitor.port}`,
				origin: `http://${slug}.localhost:${server.visitor.port}`,
				"content-type": "application/json",
				...extra,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		});
	return { store, server, admin, visitor };
}
async function create(h: ReturnType<typeof harness>, slug = "test-site") {
	const response = await h.admin("/projects", "POST", {
		name: "Test site",
		slug,
	});
	if (response.status !== 201) {
		throw new Error(await response.text());
	}
	return (await response.json()) as RuntimeSite;
}
async function save(
	h: ReturnType<typeof harness>,
	site: RuntimeSite,
	html = starterHtml("Test", "website", "")
) {
	const response = await h.admin(`/projects/${site.id}/versions`, "POST", {
		html,
		expectedRevision: site.revision,
	});
	if (response.status !== 201) {
		throw new Error(await response.text());
	}
	return (await response.json()) as RuntimeSite;
}
async function deploy(h: ReturnType<typeof harness>, site: RuntimeSite) {
	const response = await h.admin(`/projects/${site.id}/deploy`, "POST", {
		versionId: site.versions.at(-1)?.id,
		expectedRevision: site.revision,
	});
	if (response.status !== 200) {
		throw new Error(await response.text());
	}
	return (await response.json()) as RuntimeSite;
}
async function publish(h: ReturnType<typeof harness>, site: RuntimeSite) {
	const response = await h.admin(`/projects/${site.id}/settings`, "PUT", {
		settings: { ...site.settings, audience: "public" },
		expectedRevision: site.revision,
	});
	if (response.status !== 200) {
		throw new Error(await response.text());
	}
	return (await response.json()) as RuntimeSite;
}
describe("Sites management and visitor boundaries", () => {
	test("persists versions separately from deployment and revokes access immediately", async () => {
		const h = harness();
		let site = await create(h);
		expect((await h.admin("/projects", "GET", undefined, "bad")).status).toBe(
			401
		);
		expect((await h.visitor(site.slug)).status).toBe(404);
		site = await save(h, site);
		expect((await h.visitor(site.slug)).status).toBe(404);
		site = await deploy(h, site);
		expect((await h.visitor(site.slug)).status).toBe(403);
		site = await publish(h, site);
		const response = await h.visitor(site.slug);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toContain(
			"connect-src 'self'"
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'"
		);
		const deployed = site.deploymentId;
		site = await save(h, site, "<!doctype html><h1>Changed draft</h1>");
		expect(site.deploymentId).toBe(deployed);
		expect(await (await h.visitor(site.slug)).text()).not.toContain(
			"Changed draft"
		);
		const off = await h.admin(`/projects/${site.id}/unpublish`, "POST", {
			expectedRevision: site.revision,
		});
		expect(off.status).toBe(200);
		expect((await h.visitor(site.slug)).status).toBe(404);
	});
	test("rejects stale saves, incompatible builds, disabled public publishing and spoofed identity", async () => {
		const h = harness({}, false);
		let site = await create(h);
		expect(
			(
				await h.admin(`/projects/${site.id}/versions`, "POST", {
					html: "not a build",
					expectedRevision: 0,
				})
			).status
		).toBe(400);
		site = await save(h, site);
		expect(
			(
				await h.admin(`/projects/${site.id}/versions`, "POST", {
					html: "<!doctype html>stale",
					expectedRevision: 0,
				})
			).status
		).toBe(409);
		expect(
			(
				await h.admin(`/projects/${site.id}/settings`, "PUT", {
					settings: { ...site.settings, audience: "public" },
					expectedRevision: site.revision,
				})
			).status
		).toBe(403);
		site = await deploy(h, site);
		expect(
			(
				await h.visitor(site.slug, "/", "GET", undefined, {
					"x-user-id": site.ownerId,
					authorization: "Bearer owner-test-token",
				})
			).status
		).toBe(403);
	});
	test("URL changes preserve route/query redirects without redeploying; deletion cleans artifacts", async () => {
		const h = harness();
		let site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		const deployed = site.deploymentId;
		const response = await h.admin(`/projects/${site.id}/url`, "PUT", {
			slug: "renamed-site",
			expectedRevision: site.revision,
		});
		site = (await response.json()) as RuntimeSite;
		expect(site.deploymentId).toBe(deployed);
		const redirect = await h.visitor("test-site", "/guide?q=hello");
		expect(redirect.status).toBe(308);
		expect(redirect.headers.get("location")).toContain(
			"renamed-site.localhost"
		);
		expect(redirect.headers.get("location")).toEndWith("/guide?q=hello");
		expect(
			(
				await h.admin("/projects", "POST", {
					name: "Collision",
					slug: "test-site",
				})
			).status
		).toBe(409);
		expect(
			(
				await h.admin(`/projects/${site.id}`, "DELETE", {
					slug: "wrong",
					expectedRevision: site.revision,
				})
			).status
		).toBe(400);
		expect(
			(
				await h.admin(`/projects/${site.id}`, "DELETE", {
					slug: site.slug,
					expectedRevision: site.revision,
				})
			).status
		).toBe(200);
		expect(h.store.db.query("SELECT * FROM artifacts").all()).toHaveLength(0);
	});
	test("records are isolated by site and verified visitor; mutations reject cross-origin requests", async () => {
		const identity = async (
			request: Request
		): Promise<SitePrincipal | null> => {
			const auth = request.headers.get("authorization");
			return auth === "Bearer visitor-a" || auth === "Bearer visitor-b"
				? { id: auth, email: `${auth.slice(-1)}@example.com`, workspaceIds: [] }
				: null;
		};
		const h = harness({ identity });
		let site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		const settings = await h.admin(`/projects/${site.id}/settings`, "PUT", {
			settings: {
				...site.settings,
				mode: "connected",
				storage: true,
				uploads: true,
			},
			expectedRevision: site.revision,
		});
		site = (await settings.json()) as RuntimeSite;
		const headers = { authorization: "Bearer visitor-a" };
		expect(
			(
				await h.visitor(site.slug, "/_ryu/records/notes/first", "PUT", {
					text: "private",
				})
			).status
		).toBe(401);
		expect(
			(
				await h.visitor(
					site.slug,
					"/_ryu/records/notes/first",
					"PUT",
					{ text: "private" },
					{ ...headers, origin: "https://evil.example" }
				)
			).status
		).toBe(403);
		expect(
			(
				await h.visitor(
					site.slug,
					"/_ryu/records/notes/first",
					"PUT",
					{ text: "private" },
					headers
				)
			).status
		).toBe(200);
		expect(
			await (
				await h.visitor(
					site.slug,
					"/_ryu/records/notes",
					"GET",
					undefined,
					headers
				)
			).json()
		).toHaveLength(1);
		expect(
			await (
				await h.visitor(site.slug, "/_ryu/records/notes", "GET", undefined, {
					authorization: "Bearer visitor-b",
				})
			).json()
		).toHaveLength(0);
		const upload = await h.visitor(
			site.slug,
			"/_ryu/files",
			"POST",
			{ name: "evil.html", data: btoa("<script>bad()</script>") },
			headers
		);
		expect(upload.status).toBe(201);
		const file = (await upload.json()) as { id: string };
		const downloaded = await h.visitor(
			site.slug,
			`/_ryu/files/${file.id}`,
			"GET",
			undefined,
			headers
		);
		expect(downloaded.headers.get("content-disposition")).toBe("attachment");
		expect(
			(
				await h.visitor(site.slug, `/_ryu/files/${file.id}`, "GET", undefined, {
					authorization: "Bearer visitor-b",
				})
			).status
		).toBe(404);
	});
	test("custom domains start pending and cannot claim TLS from user input", async () => {
		const h = harness();
		const site = await create(h);
		const response = await h.admin(`/projects/${site.id}/domains`, "POST", {
			host: "help.example.com",
			expectedRevision: site.revision,
		});
		const next = (await response.json()) as RuntimeSite;
		expect(next.domains[0]?.status).toBe("pending_dns");
		expect(
			(
				await h.admin(`/projects/${site.id}/domains`, "POST", {
					host: "other.example.com",
					status: "active",
					expectedRevision: next.revision,
				})
			).status
		).toBe(400);
	});
	test("reset calendar starts one owner-gated agent check", async () => {
		const calls: string[] = [];
		const owner: SitePrincipal = {
			id: "node-owner",
			email: "owner@example.com",
			workspaceIds: [],
		};
		const identity = async (request: Request): Promise<SitePrincipal | null> =>
			request.headers.get("authorization") === "Bearer viewer"
				? { id: "viewer", email: "viewer@example.com", workspaceIds: [] }
				: owner;
		const h = harness({
			identity,
			runResetAction: async ({ provider }) => {
				calls.push(provider);
				return {
					detail: "status: scheduled; observed resetAt is tomorrow",
					provider,
					status: "completed",
				};
			},
		});
		const created = await h.admin("/projects", "POST", {
			name: "Reset Atlas",
			slug: "reset-atlas",
			template: "reset-calendar",
		});
		let site = (await created.json()) as RuntimeSite;
		site = await save(
			h,
			site,
			starterHtml("Reset Atlas", "reset-calendar", "Track your windows.")
		);
		site = await deploy(h, site);
		const settings = await h.admin(`/projects/${site.id}/settings`, "PUT", {
			settings: {
				...site.settings,
				agentActions: true,
				audience: "public",
			},
			expectedRevision: site.revision,
		});
		site = (await settings.json()) as RuntimeSite;
		const response = await h.visitor(site.slug, "/_ryu/reset", "POST", {
			provider: "codex",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			provider: "codex",
			status: "completed",
		});
		expect(calls).toEqual(["codex"]);
		const viewer = await h.visitor(
			site.slug,
			"/_ryu/reset",
			"POST",
			{ provider: "claude" },
			{ authorization: "Bearer viewer" }
		);
		expect(viewer.status).toBe(403);
		expect(calls).toEqual(["codex"]);
	});
});
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
	const report = (await (
		await h.admin(`/projects/${site.id}/security`)
	).json()) as { status: string; artifactDigest: string };
	expect(report.status).toBe("blocked");
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
