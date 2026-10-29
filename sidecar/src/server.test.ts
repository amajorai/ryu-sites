import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarHostError } from "@ryu/sidecar-runtime";
import { z } from "zod";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createEdgeReadiness } from "./edge-readiness.ts";
import { createSitesRetrieval } from "./platform.ts";
import { createSitesServer, type SitesServices } from "./server.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import type {
	LegacySiteRecord,
	SitesSpacesDatabase,
} from "./spaces-database.ts";
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
function harness(
	services: SitesServices = {},
	publicEnabled = true,
	trustedProxies: string[] = [],
	storePath = ":memory:",
	poweredByRyu = false
) {
	const store = new SitesStore(storePath);
	const recordsByDatabase = new Map<string, LegacySiteRecord[]>();
	const deletedDatabases: string[] = [];
	const spacesDatabase: SitesSpacesDatabase = {
		ensureForSite: async ({ id }) => ({
			spaceId: `space-${id}`,
			databaseId: `database-${id}`,
		}),
		query: async (binding) => ({
			columns: ["records"],
			rows: [[recordsByDatabase.get(binding.databaseId)?.length ?? 0]],
			schema: [],
			truncated: false,
		}),
		records: async (binding, owner, collection, key) =>
			(recordsByDatabase.get(binding.databaseId) ?? [])
				.filter(
					(record) =>
						record.owner === owner &&
						record.collection === collection &&
						(key === null || record.key === key)
				)
				.map((record) => ({
					key: record.key,
					value: JSON.parse(record.value),
				})),
		saveRecord: async (binding, input) => {
			const records = recordsByDatabase.get(binding.databaseId) ?? [];
			const index = records.findIndex(
				(record) =>
					record.owner === input.owner &&
					record.collection === input.collection &&
					record.key === input.key
			);
			if (index >= 0) {
				records[index] = input;
			} else {
				records.push(input);
			}
			recordsByDatabase.set(binding.databaseId, records);
		},
		deleteRecord: async (binding, owner, collection, key) => {
			const records = recordsByDatabase.get(binding.databaseId) ?? [];
			const remaining = records.filter(
				(record) =>
					!(
						record.owner === owner &&
						record.collection === collection &&
						record.key === key
					)
			);
			recordsByDatabase.set(binding.databaseId, remaining);
			return remaining.length !== records.length;
		},
		count: async (binding) =>
			recordsByDatabase.get(binding.databaseId)?.length ?? 0,
		ownerUsage: async (binding) => {
			const usage = new Map<string, { records: number; bytes: number }>();
			for (const record of recordsByDatabase.get(binding.databaseId) ?? []) {
				const current = usage.get(record.owner) ?? { records: 0, bytes: 0 };
				current.records += 1;
				current.bytes += record.value.length;
				usage.set(record.owner, current);
			}
			return [...usage].map(([owner, totals]) => ({ owner, ...totals }));
		},
		ownerRecords: async (binding, owner) =>
			(recordsByDatabase.get(binding.databaseId) ?? [])
				.filter((record) => record.owner === owner)
				.map((record) => ({
					collection: record.collection,
					key: record.key,
					value: JSON.parse(record.value),
				})),
		deleteOwnerRecords: async (binding, owner) => {
			const records = recordsByDatabase.get(binding.databaseId) ?? [];
			const remaining = records.filter((record) => record.owner !== owner);
			recordsByDatabase.set(binding.databaseId, remaining);
			return records.length - remaining.length;
		},
		importRecords: async (binding, records) => {
			recordsByDatabase.set(binding.databaseId, [...records]);
		},
		deleteDatabase: async (binding) => {
			recordsByDatabase.delete(binding.databaseId);
			deletedDatabases.push(binding.databaseId);
		},
	};
	const server = createSitesServer({
		store,
		token: "owner-test-token",
		port: 0,
		visitorPort: 0,
		services: {
			scanArtifact: async () => ({ allowed: true, reason: null }),
			spacesDatabase,
			...services,
		},
		poweredByRyu,
		publicEnabled,
		trustedProxies,
	});
	cleanup.push(() => {
		server.stop();
		store.close();
	});
	const admin = (
		path: string,
		method = "GET",
		body?: SiteDataValue,
		token = "owner-test-token"
	) =>
		(() => {
			const target = `http://127.0.0.1:${server.admin.port}/api/sites${path}`;
			const options = {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			} satisfies RequestInit;
			return fetch(target, options);
		})();
	const visitor = (
		slug: string,
		path = "/",
		method = "GET",
		body?: SiteDataValue,
		extra: Record<string, string> = {}
	) =>
		(() => {
			const target = `http://127.0.0.1:${server.visitor.port}${path}`;
			const options = {
				method,
				headers: {
					host: `${slug}.localhost:${server.visitor.port}`,
					origin: `http://${slug}.localhost:${server.visitor.port}`,
					"content-type": "application/json",
					...extra,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "manual",
			} satisfies RequestInit;
			return fetch(target, options);
		})();
	return { store, server, admin, visitor, deletedDatabases };
}
async function create(h: ReturnType<typeof harness>, slug = "test-site") {
	const response = await h.admin("/projects", "POST", {
		name: "Test site",
		slug,
	});
	if (response.status !== 201) {
		throw new Error(await response.text());
	}
	return runtimeSiteSchema.parse(await response.json());
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
	return runtimeSiteSchema.parse(await response.json());
}
async function deploy(h: ReturnType<typeof harness>, site: RuntimeSite) {
	const response = await h.admin(`/projects/${site.id}/deploy`, "POST", {
		versionId: site.versions.at(-1)?.id,
		expectedRevision: site.revision,
	});
	if (response.status !== 200) {
		throw new Error(await response.text());
	}
	return runtimeSiteSchema.parse(await response.json());
}
async function publish(h: ReturnType<typeof harness>, site: RuntimeSite) {
	const response = await h.admin(`/projects/${site.id}/settings`, "PUT", {
		settings: { ...site.settings, audience: "public" },
		expectedRevision: site.revision,
	});
	if (response.status !== 200) {
		throw new Error(await response.text());
	}
	return runtimeSiteSchema.parse(await response.json());
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

	test("email-matched editors and invited viewers resolve from Core's verified caller email", async () => {
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
					...caller,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const member = (id: string, email?: string) => ({
			"x-ryu-caller-user-id": id,
			"x-ryu-caller-org-id": "org-1",
			...(email ? { "x-ryu-caller-email": email } : {}),
		});
		const owner = member("member-a", "owner@example.com");
		const editor = member("member-b", "Editor@Example.com");
		const viewer = member("member-c", "viewer@example.com");
		const stranger = member("member-d", "other@example.com");
		const created = await coreHop("/projects", owner, "POST", {
			name: "Team site",
			slug: "team-site",
		});
		let site = runtimeSiteSchema.parse(await created.json());
		const shared = await coreHop(
			`/projects/${site.id}/settings`,
			owner,
			"PUT",
			{
				settings: {
					...site.settings,
					audience: "invited",
					workspaceId: "org-1",
					editors: ["editor@example.com"],
					viewers: ["viewer@example.com"],
				},
				expectedRevision: site.revision,
			}
		);
		expect(shared.status).toBe(200);
		site = runtimeSiteSchema.parse(await shared.json());
		const sharedWith = async (caller: Record<string, string>) =>
			(await (await coreHop("/projects?scope=shared", caller)).json()).map(
				(item: RuntimeSite) => ({ id: item.id, access: item.access })
			);
		expect(await sharedWith(editor)).toEqual([
			{ id: site.id, access: "editor" },
		]);
		expect(await sharedWith(viewer)).toEqual([
			{ id: site.id, access: "viewer" },
		]);
		expect(await sharedWith(stranger)).toEqual([]);
		expect(await sharedWith(member("member-b"))).toEqual([]);
		const saveAs = (caller: Record<string, string>) =>
			coreHop(`/projects/${site.id}/versions`, caller, "POST", {
				html: starterHtml("Team", "website", ""),
				expectedRevision: site.revision,
			});
		expect((await saveAs(viewer)).status).toBe(403);
		expect((await saveAs(member("member-b"))).status).toBe(403);
		const saved = await saveAs(editor);
		expect(saved.status).toBe(201);
		site = runtimeSiteSchema.parse(await saved.json());
		expect(site.versions).toHaveLength(1);
		// Editors still cannot manage owner settings.
		expect(
			(
				await coreHop(`/projects/${site.id}/settings`, editor, "PUT", {
					settings: site.settings,
					expectedRevision: site.revision,
				})
			).status
		).toBe(403);
		expect((await coreHop(`/projects/${site.id}`, stranger)).status).toBe(403);
	});

	test("analytics returns daily traffic and top page paths", async () => {
		const h = harness();
		const site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		await h.visitor(site.slug, "/");
		await h.visitor(site.slug, "/pricing?utm=first");
		await h.visitor(site.slug, "/pricing?utm=second");
		const response = await h.admin(`/projects/${site.id}/analytics?days=7`);
		const report = await response.json();
		expect(report.summary).toEqual({ pageViews: 3, uniqueVisitors: 1 });
		expect(report.daily).toHaveLength(1);
		expect(report.daily[0]).toMatchObject({ pageViews: 3, uniqueVisitors: 1 });
		expect(report.topPages).toEqual([
			{ path: "/pricing", pageViews: 2, uniqueVisitors: 1 },
			{ path: "/", pageViews: 1, uniqueVisitors: 1 },
		]);
	});

	test("deleting a Site removes its Ryu Spaces database document", async () => {
		const h = harness();
		let site = await create(h);
		const connected = await h.admin(
			`/projects/${site.id}/database/connect`,
			"POST",
			{ expectedRevision: site.revision }
		);
		site = runtimeSiteSchema.parse(await connected.json());
		const databaseId = site.settings.database?.databaseId;
		if (databaseId === undefined) {
			throw new Error("The Site database was not connected");
		}
		const deleted = await h.admin(`/projects/${site.id}`, "DELETE", {
			slug: site.slug,
			expectedRevision: site.revision,
		});
		expect(deleted.status).toBe(200);
		expect(h.deletedDatabases).toEqual([databaseId]);
	});

	test("custom domains start pending and cannot claim TLS from user input", async () => {
		const h = harness();
		expect((await (await h.admin("/status")).json()).domainsAvailable).toBe(
			false
		);
		const site = await create(h);
		const response = await h.admin(`/projects/${site.id}/domains`, "POST", {
			host: "help.example.com",
			expectedRevision: site.revision,
		});
		const next = runtimeSiteSchema.parse(await response.json());
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
	test("custom domains require the exact TXT record and a ready TLS binding", async () => {
		let expectedVerification = "";
		let tlsReady = false;
		const resolvedNames: string[] = [];
		const tlsChecks: Array<{ host: string; siteId: string }> = [];
		const h = harness({
			domainReady: async (siteId, host) => {
				tlsChecks.push({ host, siteId });
				return tlsReady;
			},
			resolveDomainTxtRecords: async (recordName) => {
				resolvedNames.push(recordName);
				return [[expectedVerification]];
			},
		});
		expect((await (await h.admin("/status")).json()).domainsAvailable).toBe(
			true
		);
		const site = await create(h);
		const host = "help.example.com";
		const added = await h.admin(`/projects/${site.id}/domains`, "POST", {
			expectedRevision: site.revision,
			host,
		});
		const addedSite = runtimeSiteSchema.parse(await added.json());
		expectedVerification = addedSite.domains[0]?.verification ?? "";
		expect(expectedVerification).not.toBe("");

		const checking = await h.admin(
			`/projects/${site.id}/domains/check`,
			"POST",
			{ expectedRevision: addedSite.revision, host }
		);
		let checkedSite = runtimeSiteSchema.parse(await checking.json());
		expect(checkedSite.domains[0]?.status).toBe("pending_tls");

		tlsReady = true;
		const ready = await h.admin(`/projects/${site.id}/domains/check`, "POST", {
			expectedRevision: checkedSite.revision,
			host,
		});
		checkedSite = runtimeSiteSchema.parse(await ready.json());
		expect(checkedSite.domains[0]?.status).toBe("active");
		expect(checkedSite.domains[0]?.checkedAt).not.toBeNull();
		expect(resolvedNames).toEqual([`_ryu-sites.${host}`, `_ryu-sites.${host}`]);
		expect(tlsChecks).toEqual([
			{ host, siteId: site.id },
			{ host, siteId: site.id },
		]);
	});
	test("an operator edge readiness URL activates a verified domain end to end", async () => {
		let expectedVerification = "";
		let visitorPort = 0;
		const probes: string[] = [];
		// Stands in for the operator's edge at a screened public address: it
		// terminates HTTPS for the custom domain and forwards the request to the
		// Sites visitor listener.
		const h = harness({
			domainReady: createEdgeReadiness({
				readinessUrl: "https://{host}/_ryu/edge-ready",
				resolve: async () => [{ address: "93.184.215.14", family: 4 }],
				send: async ({ address, url }) => {
					probes.push(`${url.href} via ${address?.address}`);
					const response = await fetch(
						`http://127.0.0.1:${visitorPort}${url.pathname}`,
						{ headers: { host: url.host } }
					);
					return { status: response.status, body: await response.text() };
				},
			}),
			resolveDomainTxtRecords: async () => [[expectedVerification]],
		});
		visitorPort = h.server.visitor.port ?? 0;
		expect((await (await h.admin("/status")).json()).domainsAvailable).toBe(
			true
		);
		const host = "help.example.com";
		const unbound = await h.visitor(
			"unused",
			"/_ryu/edge-ready",
			"GET",
			undefined,
			{ host }
		);
		expect(unbound.status).toBe(404);
		let site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		const added = await h.admin(`/projects/${site.id}/domains`, "POST", {
			expectedRevision: site.revision,
			host,
		});
		site = runtimeSiteSchema.parse(await added.json());
		expectedVerification = site.domains[0]?.verification ?? "";
		// A pending domain is not served, but the readiness path answers for it.
		expect(
			(await h.visitor(site.slug, "/", "GET", undefined, { host })).status
		).toBe(404);
		const checked = await h.admin(
			`/projects/${site.id}/domains/check`,
			"POST",
			{
				expectedRevision: site.revision,
				host,
			}
		);
		site = runtimeSiteSchema.parse(await checked.json());
		expect(site.domains[0]?.status).toBe("active");
		expect(probes).toEqual([
			`https://${host}/_ryu/edge-ready via 93.184.215.14`,
		]);
		const served = await h.visitor(site.slug, "/", "GET", undefined, { host });
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toContain("text/html");
	});
	test("a domain stays pending TLS when the edge does not confirm it", async () => {
		let expectedVerification = "";
		const h = harness({
			domainReady: createEdgeReadiness({
				readinessUrl: "https://edge.example.com/ready?host={host}",
				send: async () => ({ status: 502, body: "Bad gateway" }),
			}),
			resolveDomainTxtRecords: async () => [[expectedVerification]],
		});
		let site = await create(h);
		const added = await h.admin(`/projects/${site.id}/domains`, "POST", {
			expectedRevision: site.revision,
			host: "help.example.com",
		});
		site = runtimeSiteSchema.parse(await added.json());
		expectedVerification = site.domains[0]?.verification ?? "";
		const checked = await h.admin(
			`/projects/${site.id}/domains/check`,
			"POST",
			{
				expectedRevision: site.revision,
				host: "help.example.com",
			}
		);
		expect(
			runtimeSiteSchema.parse(await checked.json()).domains[0]?.status
		).toBe("pending_tls");
	});
	test("reset checks require the owner management hop and never visitor cookies", async () => {
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
		let site = runtimeSiteSchema.parse(await created.json());
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
		site = runtimeSiteSchema.parse(await settings.json());
		const blocked = await h.visitor(site.slug, "/_ryu/reset", "POST", {
			provider: "codex",
		});
		expect(blocked.status).toBe(403);
		expect(calls).toEqual([]);
		const path = `/projects/${site.id}/reset`;
		const input = { provider: "codex", expectedRevision: site.revision };
		expect(
			(await h.admin(path, "POST", input, "visitor-cookie-only")).status
		).toBe(403);
		expect(
			(await h.admin(path, "POST", { ...input, provider: "unknown" })).status
		).toBe(400);
		expect(
			(
				await h.admin(path, "POST", {
					...input,
					expectedRevision: site.revision - 1,
				})
			).status
		).toBe(409);
		const crossOrigin = await (() => {
			const target = `http://127.0.0.1:${h.server.admin.port}/api/sites${path}`;
			const options = {
				method: "POST",
				headers: {
					authorization: "Bearer owner-test-token",
					origin: `http://${site.slug}.localhost`,
					"content-type": "application/json",
				},
				body: JSON.stringify(input),
			} satisfies RequestInit;
			return fetch(target, options);
		})();
		expect(crossOrigin.status).toBe(403);
		expect(calls).toEqual([]);
		const response = await h.admin(path, "POST", input);
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

describe("per-visitor shares of Site-wide quotas", () => {
	const identity = async (request: Request): Promise<SitePrincipal | null> => {
		const auth = request.headers.get("authorization");
		return auth === "Bearer visitor-a" || auth === "Bearer visitor-b"
			? { id: auth, email: `${auth.slice(-1)}@example.com`, workspaceIds: [] }
			: null;
	};
	const connect = async (
		h: ReturnType<typeof harness>,
		patch: Partial<RuntimeSite["settings"]>
	) => {
		let site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		const connected = await h.admin(
			`/projects/${site.id}/database/connect`,
			"POST",
			{ expectedRevision: site.revision }
		);
		site = runtimeSiteSchema.parse(await connected.json());
		const updated = await h.admin(`/projects/${site.id}/settings`, "PUT", {
			settings: { ...site.settings, mode: "connected", ...patch },
			expectedRevision: site.revision,
		});
		if (updated.status !== 200) {
			throw new Error(await updated.text());
		}
		return runtimeSiteSchema.parse(await updated.json());
	};

	test("one visitor's uploads cannot use up the Site's file quota", async () => {
		const h = harness({ identity });
		const site = await connect(h, { uploads: true });
		const upload = (visitor: string) =>
			h.visitor(
				site.slug,
				"/_ryu/files",
				"POST",
				{ name: "note.txt", data: btoa("hello") },
				{ authorization: `Bearer ${visitor}` }
			);
		const statuses: number[] = [];
		for (let index = 0; index < 11; index += 1) {
			statuses.push((await upload("visitor-a")).status);
		}
		expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
		const refused = await upload("visitor-a");
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("your upload limit");
		expect((await upload("visitor-b")).status).toBe(201);
	});

	test("the owner lists and purges one visitor's data, freeing their share", async () => {
		const h = harness({ identity });
		const site = await connect(h, { storage: true, uploads: true });
		const as = (visitor: string) => ({ authorization: `Bearer ${visitor}` });
		const upload = (visitor: string) =>
			h.visitor(
				site.slug,
				"/_ryu/files",
				"POST",
				{ name: "note.txt", data: btoa("hello") },
				as(visitor)
			);
		for (let index = 0; index < 10; index += 1) {
			expect((await upload("visitor-a")).status).toBe(201);
		}
		expect((await upload("visitor-a")).status).toBe(429);
		expect((await upload("visitor-b")).status).toBe(201);
		for (const [visitor, key] of [
			["visitor-a", "first"],
			["visitor-a", "second"],
			["visitor-b", "first"],
		] as const) {
			const saved = await h.visitor(
				site.slug,
				`/_ryu/records/notes/${key}`,
				"PUT",
				{ text: key },
				as(visitor)
			);
			expect(saved.status).toBe(200);
		}
		const listing = z.object({
			visitors: z.array(
				z.object({
					visitor: z.string(),
					owner: z.string(),
					files: z.number(),
					fileBytes: z.number(),
					records: z.number(),
					recordBytes: z.number(),
				})
			),
			audit: z.array(
				z.object({
					action: z.string(),
					actor: z.string(),
					at: z.string(),
					visitor: z.string(),
					files: z.number(),
					fileBytes: z.number(),
					records: z.number(),
				})
			),
		});
		const list = async () =>
			listing.parse(
				await (await h.admin(`/projects/${site.id}/visitors`)).json()
			);
		const before = await list();
		expect(
			before.visitors.map(({ owner, files, fileBytes, records }) => ({
				owner,
				files,
				fileBytes,
				records,
			}))
		).toEqual([
			{ owner: "Bearer visitor-a", files: 10, fileBytes: 50, records: 2 },
			{ owner: "Bearer visitor-b", files: 1, fileBytes: 5, records: 1 },
		]);
		expect(before.audit).toEqual([]);
		const target = before.visitors[0]?.visitor ?? "";
		expect(target).toMatch(/^[A-Za-z0-9_-]+$/);

		// Visitors and editors never reach owner tools, and keys must be canonical.
		expect(
			(
				await h.admin(
					`/projects/${site.id}/visitors`,
					"GET",
					undefined,
					"visitor-a"
				)
			).status
		).toBe(403);
		expect(
			(
				await h.admin(
					`/projects/${site.id}/visitors/${target}/data`,
					"DELETE",
					undefined,
					"visitor-a"
				)
			).status
		).toBe(403);
		for (const key of ["not=canonical", "%2F", `${target}=`]) {
			const refused = await h.admin(
				`/projects/${site.id}/visitors/${key}/data`,
				"DELETE"
			);
			expect(refused.status).toBe(400);
		}

		const purged = await h.admin(
			`/projects/${site.id}/visitors/${target}/data`,
			"DELETE"
		);
		expect(purged.status).toBe(200);
		expect(await purged.json()).toMatchObject({
			visitor: target,
			deleted: { files: 10, fileBytes: 50, records: 2 },
		});
		const after = await list();
		expect(after.visitors.map((entry) => entry.owner)).toEqual([
			"Bearer visitor-b",
		]);
		expect(after.audit).toHaveLength(1);
		expect(after.audit[0]).toMatchObject({
			action: "visitor_data.delete",
			actor: "node-owner",
			files: 10,
			fileBytes: 50,
			records: 2,
		});
		expect(after.audit[0]?.visitor).toMatch(/^[a-f0-9]{16}$/);
		expect(
			JSON.stringify(h.store.db.query("SELECT * FROM site_audit").all())
		).not.toContain("visitor-a");
		expect(
			await (
				await h.visitor(
					site.slug,
					"/_ryu/records/notes",
					"GET",
					undefined,
					as("visitor-a")
				)
			).json()
		).toEqual([]);
		expect((await upload("visitor-a")).status).toBe(201);
	});

	test("one visitor's questions cannot use up the Site's daily answers", async () => {
		const h = harness({
			identity,
			answer: async () => ({ text: "grounded", sources: [] }),
			retrieve: async () => [],
			canBindSpace: () => true,
		});
		const site = await connect(h, {
			ai: true,
			aiDailyLimit: 10,
			spaceId: "approved",
		});
		const ask = (visitor: string) =>
			h.visitor(
				site.slug,
				"/_ryu/ask",
				"POST",
				{ query: "What is new?" },
				{ authorization: `Bearer ${visitor}` }
			);
		expect((await ask("visitor-a")).status).toBe(200);
		expect((await ask("visitor-a")).status).toBe(200);
		const refused = await ask("visitor-a");
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("your daily answer limit");
		expect((await ask("visitor-b")).status).toBe(200);
		const stored = h.store.db
			.query("SELECT kind FROM operation_usage WHERE kind != 'answer'")
			.all();
		expect(JSON.stringify(stored)).not.toContain("visitor-a");
	});

	test("a restart keeps each visitor's daily answer share", async () => {
		const directory = mkdtempSync(join(tmpdir(), "sites-answers-"));
		cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
		const path = join(directory, "sites.sqlite");
		const services: SitesServices = {
			identity,
			answer: async () => ({ text: "grounded", sources: [] }),
			retrieve: async () => [],
			canBindSpace: () => true,
		};
		const ask = (
			h: ReturnType<typeof harness>,
			slug: string,
			visitor: string
		) =>
			h.visitor(
				slug,
				"/_ryu/ask",
				"POST",
				{ query: "What is new?" },
				{ authorization: `Bearer ${visitor}` }
			);
		const first = harness(services, true, [], path);
		const site = await connect(first, {
			ai: true,
			aiDailyLimit: 10,
			spaceId: "approved",
		});
		expect((await ask(first, site.slug, "visitor-a")).status).toBe(200);
		expect((await ask(first, site.slug, "visitor-a")).status).toBe(200);
		first.server.stop();
		first.store.close();
		const restarted = harness(services, true, [], path);
		const refused = await ask(restarted, site.slug, "visitor-a");
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("your daily answer limit");
		expect((await ask(restarted, site.slug, "visitor-b")).status).toBe(200);
	});
	const completer = () => {
		const calls: { system: string; prompt: string }[] = [];
		let reply: () => Promise<string> = async () => "model reply";
		return {
			calls,
			setReply: (next: () => Promise<string>) => {
				reply = next;
			},
			complete: async (input: { system: string; prompt: string }) => {
				calls.push(input);
				return reply();
			},
		};
	};
	const callAi = (
		h: ReturnType<typeof harness>,
		slug: string,
		payload: SiteDataValue,
		visitor?: string
	) =>
		h.visitor(
			slug,
			"/_ryu/complete",
			"POST",
			payload,
			visitor ? { authorization: `Bearer ${visitor}` } : {}
		);

	test("general AI composes owner instructions before page text without a Space", async () => {
		const model = completer();
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, {
			ai: true,
			aiMode: "general",
			aiSystemPrompt: "Always answer in French.",
		});
		expect(site.settings.spaceId).toBeNull();
		const config = await (await h.visitor(site.slug, "/_ryu/config")).json();
		expect(config).toMatchObject({ completions: true, aiAnonymous: false });
		const response = await callAi(
			h,
			site.slug,
			{ prompt: "Summarize this page", system: "Be brief." },
			"visitor-a"
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "model reply" });
		const system = model.calls[0]?.system ?? "";
		expect(model.calls[0]?.prompt).toBe("Summarize this page");
		expect(system.indexOf("Always answer in French.")).toBeGreaterThan(0);
		expect(system.indexOf("Always answer in French.")).toBeLessThan(
			system.indexOf("Be brief.")
		);
		const chat = await callAi(
			h,
			site.slug,
			{
				messages: [
					{ role: "user", content: "Hi" },
					{ role: "assistant", content: "Hello" },
					{ role: "user", content: "Classify: great product" },
				],
			},
			"visitor-a"
		);
		expect(chat.status).toBe(200);
		expect(model.calls[1]?.prompt).toContain("Classify: great product");
	});

	test("general AI is gated by mode, sign-in and the model service", async () => {
		const model = completer();
		const h = harness({
			identity,
			complete: model.complete,
			answer: async () => ({ text: "grounded", sources: [] }),
			retrieve: async () => [],
			canBindSpace: () => true,
		});
		const grounded = await connect(h, { ai: true, spaceId: "approved" });
		const refused = await callAi(
			h,
			grounded.slug,
			{ prompt: "Hi" },
			"visitor-a"
		);
		expect(refused.status).toBe(403);
		expect(await refused.text()).toContain("General AI is not enabled");

		const other = harness({ identity, complete: model.complete });
		const general = await connect(other, { ai: true, aiMode: "general" });
		const anonymous = await callAi(other, general.slug, { prompt: "Hi" });
		expect(anonymous.status).toBe(401);
		const updated = await other.admin(
			`/projects/${general.id}/settings`,
			"PUT",
			{
				settings: { ...general.settings, aiAnonymous: true },
				expectedRevision: general.revision,
			}
		);
		expect(updated.status).toBe(200);
		expect((await callAi(other, general.slug, { prompt: "Hi" })).status).toBe(
			200
		);
		expect(model.calls).toHaveLength(1);

		// No model service: the owner cannot enable general AI at all.
		const noModel = harness({ identity });
		await expect(
			connect(noModel, { ai: true, aiMode: "general" })
		).rejects.toThrow("Connect a Ryu model");
	});

	test("general AI never returns invented text when the model fails", async () => {
		const model = completer();
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, { ai: true, aiMode: "general" });
		model.setReply(() => Promise.reject(new SidecarHostError(503)));
		const failed = await callAi(h, site.slug, { prompt: "Hi" }, "visitor-a");
		expect(failed.status).toBe(503);
		expect(await failed.json()).not.toHaveProperty("text");
		model.setReply(async () => "   ");
		const empty = await callAi(h, site.slug, { prompt: "Hi" }, "visitor-a");
		expect(empty.status).toBe(503);
		expect(await empty.text()).toContain("no answer");
	});

	test("general AI maps every model failure except a permission denial to 503", async () => {
		const model = completer();
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, { ai: true, aiMode: "general" });
		const failures: (() => Promise<string>)[] = [
			() => Promise.reject(new TypeError("fetch failed")),
			() =>
				Promise.reject(
					new DOMException("The operation timed out.", "TimeoutError")
				),
			() => Promise.reject(new SidecarHostError(400)),
			() => Promise.reject(new SidecarHostError(500)),
			() =>
				Promise.resolve(
					z.string().parse({ text: "not a string" }) as unknown as string
				),
			() => Promise.resolve({ text: "object" } as unknown as string),
		];
		for (const failure of failures) {
			model.setReply(failure);
			const response = await callAi(
				h,
				site.slug,
				{ prompt: "Hi" },
				"visitor-a"
			);
			expect(response.status).toBe(503);
			const payload = await response.json();
			expect(payload).not.toHaveProperty("text");
			expect(payload.error.code).toBe("unavailable");
		}
		model.setReply(() => Promise.reject(new SidecarHostError(403)));
		const denied = await callAi(h, site.slug, { prompt: "Hi" }, "visitor-b");
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe(
			"platform_permission_required"
		);
	});

	test("general AI without a Space does not advertise grounded answers", async () => {
		const model = completer();
		const h = harness({
			identity,
			complete: model.complete,
			answer: async () => ({ text: "grounded", sources: [] }),
		});
		const site = await connect(h, { ai: true, aiMode: "general" });
		expect(site.settings.spaceId).toBeNull();
		const config = await (await h.visitor(site.slug, "/_ryu/config")).json();
		expect(config).toMatchObject({ answers: false, completions: true });
	});

	test("owner AI instructions are hidden from editors and viewers", async () => {
		const model = completer();
		const h = harness({
			complete: model.complete,
			managementIdentity: async () => ({
				id: "owner",
				email: "owner@example.com",
				workspaceIds: ["team"],
			}),
			identity: async (request) => {
				const principal = await identity(request);
				return principal?.id === "Bearer visitor-b"
					? { ...principal, workspaceIds: ["team"] }
					: principal;
			},
		});
		const site = await connect(h, {
			ai: true,
			aiMode: "general",
			aiSystemPrompt: "Confidential owner guidance.",
			audience: "invited",
			workspaceId: "team",
			viewers: ["a@example.com"],
			editors: ["b@example.com"],
		});
		const owner = await (await h.admin(`/projects/${site.id}`)).json();
		expect(owner.settings.aiSystemPrompt).toBe("Confidential owner guidance.");
		for (const [token, access] of [
			["visitor-a", "viewer"],
			["visitor-b", "editor"],
		] as const) {
			const detail = await h.admin(
				`/projects/${site.id}`,
				"GET",
				undefined,
				token
			);
			const text = await detail.text();
			expect(detail.status).toBe(200);
			expect(text).not.toContain("Confidential owner guidance.");
			expect(JSON.parse(text)).toMatchObject({
				access,
				settings: { aiSystemPrompt: "", aiMode: "general" },
			});
			const shared = await h.admin(
				"/projects?scope=shared",
				"GET",
				undefined,
				token
			);
			const list = await shared.text();
			expect(list).toContain(site.id);
			expect(list).not.toContain("Confidential owner guidance.");
		}
	});

	test("general AI caps prompts, clamps maxTokens and shares the daily answer limit", async () => {
		const model = completer();
		model.setReply(async () => "x".repeat(50_000));
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, {
			ai: true,
			aiMode: "general",
			aiDailyLimit: 10,
		});
		const tooLong = await callAi(
			h,
			site.slug,
			{ prompt: "a".repeat(8001) },
			"visitor-a"
		);
		expect(tooLong.status).toBe(413);
		expect(await tooLong.text()).toContain("8,000 characters");
		const both = await callAi(
			h,
			site.slug,
			{ prompt: "Hi", messages: [{ role: "user", content: "Hi" }] },
			"visitor-a"
		);
		expect(both.status).toBe(400);
		expect(model.calls).toHaveLength(0);

		const clamped = await callAi(
			h,
			site.slug,
			{ prompt: "Write a lot", maxTokens: 1_000_000 },
			"visitor-a"
		);
		expect(clamped.status).toBe(200);
		expect(model.calls[0]?.system).toContain("about 2000 tokens");
		const { text } = z.object({ text: z.string() }).parse(await clamped.json());
		expect(text).toHaveLength(8000);
		const small = await callAi(
			h,
			site.slug,
			{ prompt: "Short", maxTokens: 10 },
			"visitor-a"
		);
		expect(
			z.object({ text: z.string() }).parse(await small.json()).text
		).toHaveLength(40);
		// The visitor's share of 10 answers per day is 2.
		const over = await callAi(h, site.slug, { prompt: "Again" }, "visitor-a");
		expect(over.status).toBe(429);
		expect(await over.text()).toContain("your daily answer limit");
		expect(model.calls).toHaveLength(2);
		expect(
			(await callAi(h, site.slug, { prompt: "Hi" }, "visitor-b")).status
		).toBe(200);
	});
});
