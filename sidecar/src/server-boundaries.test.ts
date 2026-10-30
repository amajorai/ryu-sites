import { afterAll, describe, expect, test } from "bun:test";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createEdgeReadiness } from "./edge-readiness.ts";
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
import { starterHtml } from "./templates.ts";

afterAll(runCleanup);

describe("Sites management and visitor boundaries", () => {
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
