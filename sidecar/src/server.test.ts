import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createSitesRetrieval } from "./platform.ts";
import {
	create,
	deploy,
	harness,
	publish,
	runCleanup,
	save,
} from "./server-harness.ts";
import { runtimeSiteSchema } from "./site-records.ts";

afterAll(runCleanup);

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
	test("stamps the Powered by Ryu badge on published pages for branded plans only", async () => {
		const branded = harness({}, true, [], ":memory:", true);
		const site = await publish(
			branded,
			await deploy(branded, await save(branded, await create(branded)))
		);
		const page = await (await branded.visitor(site.slug)).text();
		expect(page).toContain('data-ryu-powered-by="sites"');
		expect(page).toContain("utm_source=sites");
		expect(page.indexOf("data-ryu-powered-by")).toBeLessThan(
			page.lastIndexOf("</body>") === -1
				? page.length
				: page.lastIndexOf("</body>")
		);

		const unbranded = harness();
		const paid = await publish(
			unbranded,
			await deploy(unbranded, await save(unbranded, await create(unbranded)))
		);
		expect(await (await unbranded.visitor(paid.slug)).text()).not.toContain(
			"data-ryu-powered-by"
		);
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
		site = runtimeSiteSchema.parse(await response.json());
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
		h.store.db
			.query(
				"INSERT INTO records(site, owner, collection, key, value) VALUES(?,?,?,?,?)"
			)
			.run(
				site.id,
				"Bearer visitor-a",
				"legacy",
				"before-connect",
				JSON.stringify({ text: "migrated" })
			);
		const connected = await h.admin(
			`/projects/${site.id}/database/connect`,
			"POST",
			{ expectedRevision: site.revision }
		);
		expect(connected.status).toBe(200);
		site = runtimeSiteSchema.parse(await connected.json());
		expect(h.store.legacyRecords(site.id)).toEqual([]);
		const settings = await h.admin(`/projects/${site.id}/settings`, "PUT", {
			settings: {
				...site.settings,
				mode: "connected",
				storage: true,
				uploads: true,
			},
			expectedRevision: site.revision,
		});
		site = runtimeSiteSchema.parse(await settings.json());
		const headers = { authorization: "Bearer visitor-a" };
		expect(
			(
				await h.visitor(site.slug, "/_ryu/records/notes/first", "PUT", {
					text: "private",
				})
			).status
		).toBe(401);
		expect(
			await (
				await h.visitor(
					site.slug,
					"/_ryu/records/legacy/before-connect",
					"GET",
					undefined,
					headers
				)
			).json()
		).toEqual([{ key: "before-connect", value: { text: "migrated" } }]);
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
		const file = z.object({ id: z.string() }).parse(await upload.json());
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
	test("owned and shared lists preserve viewer access without edit access", async () => {
		const identity = async (
			request: Request
		): Promise<SitePrincipal | null> => {
			return request.headers.get("authorization") === "Bearer visitor-a"
				? { id: "visitor-a", email: "a@example.com", workspaceIds: [] }
				: null;
		};
		const h = harness({ identity });
		let site = await save(h, await create(h));
		const updated = await h.admin(`/projects/${site.id}/settings`, "PUT", {
			settings: {
				...site.settings,
				audience: "invited",
				viewers: ["a@example.com"],
			},
			expectedRevision: site.revision,
		});
		site = runtimeSiteSchema.parse(await updated.json());
		const owned = await h.admin("/projects?scope=owned");
		const shared = await h.admin(
			"/projects?scope=shared",
			"GET",
			undefined,
			"visitor-a"
		);
		expect((await owned.json()).map((item: RuntimeSite) => item.id)).toContain(
			site.id
		);
		expect(await shared.json()).toMatchObject([
			{ id: site.id, access: "viewer" },
		]);
		const detail = await h.admin(
			`/projects/${site.id}`,
			"GET",
			undefined,
			"visitor-a"
		);
		expect((await detail.json()).access).toBe("viewer");
		const version = await h.admin(
			`/projects/${site.id}/versions/${site.versions.at(-1)?.id}`,
			"GET",
			undefined,
			"visitor-a"
		);
		expect(version.status).toBe(200);
		const edit = await h.admin(
			`/projects/${site.id}/settings`,
			"PUT",
			{ settings: site.settings, expectedRevision: site.revision },
			"visitor-a"
		);
		expect(edit.status).toBe(403);
	});

	test("loopback MCP discovery never serves Site pages on the shared origin", async () => {
		const h = harness();
		const site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		for (const host of ["127.0.0.1", "localhost"]) {
			const discovery = await h.visitor(
				site.slug,
				`/.well-known/oauth-protected-resource/sites/${site.id}/mcp`,
				"GET",
				undefined,
				{ host: `${host}:${h.server.visitor.port}` }
			);
			expect(discovery.status).toBe(404);
			expect(discovery.headers.get("content-type")).not.toContain("text/html");
		}
		expect(h.store.db.query("SELECT * FROM traffic").all()).toHaveLength(0);
	});

	test("org members manage through Core's verified caller headers, not a forwarded JWT", async () => {
		const platform = createSitesRetrieval({
			corePort: 7980,
			token: "owner-test-token",
			bindings: {},
			fetchImpl: Object.assign(
				async () =>
					Response.json({
						result: { principal: null, requiresIdentity: true },
					}),
				{ preconnect: fetch.preconnect }
			),
		});
		const h = harness({
			identity: async () => null,
			managementIdentity: platform.managementIdentity,
		});
		const coreHop = (
			path: string,
			caller: Record<string, string>,
			method = "GET",
			body?: SiteDataValue
		) =>
			fetch(`http://127.0.0.1:${h.server.admin.port}/api/sites${path}`, {
				method,
				headers: {
					authorization: "Bearer owner-test-token",
					"content-type": "application/json",
					"x-ryu-caller-principal-proof": "core-proof",
					...caller,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const memberA = {
			"x-ryu-caller-user-id": "member-a",
			"x-ryu-caller-org-id": "org-1",
		};
		const memberB = {
			"x-ryu-caller-user-id": "member-b",
			"x-ryu-caller-org-id": "org-1",
		};
		expect((await coreHop("/projects", {})).status).toBe(401);
		const created = await coreHop("/projects", memberA, "POST", {
			name: "Team site",
			slug: "team-site",
		});
		expect(created.status).toBe(201);
		let site = runtimeSiteSchema.parse(await created.json());
		expect(site.ownerId).toBe("member-a");
		const shared = await coreHop(
			`/projects/${site.id}/settings`,
			memberA,
			"PUT",
			{
				settings: {
					...site.settings,
					audience: "workspace",
					workspaceId: "org-1",
				},
				expectedRevision: site.revision,
			}
		);
		expect(shared.status).toBe(200);
		site = runtimeSiteSchema.parse(await shared.json());
		expect(
			await (await coreHop("/projects?scope=shared", memberB)).json()
		).toMatchObject([{ id: site.id, access: "viewer" }]);
		expect(
			(
				await coreHop(`/projects/${site.id}/settings`, memberB, "PUT", {
					settings: site.settings,
					expectedRevision: site.revision,
				})
			).status
		).toBe(403);
	});
});
