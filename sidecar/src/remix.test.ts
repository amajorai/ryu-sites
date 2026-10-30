import { afterAll, describe, expect, test } from "bun:test";
import {
	type RuntimeSite,
	remixableSite,
	SITE_LIMITS,
	type SitePrincipal,
	siteSettings,
} from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createSitesServer, REMIX_AUDIT_ACTION } from "./server.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import type { SitesSpacesDatabase } from "./spaces-database.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";

const cleanup: (() => void)[] = [];
afterAll(() => {
	for (const close of cleanup.splice(0)) {
		close();
	}
});

const people: Record<string, SitePrincipal> = {
	owner: {
		id: "user-owner",
		email: "owner@example.com",
		workspaceIds: ["org-1"],
	},
	editor: {
		id: "user-editor",
		email: "editor@example.com",
		workspaceIds: ["org-1"],
	},
	viewer: { id: "user-viewer", email: "viewer@example.com", workspaceIds: [] },
	stranger: {
		id: "user-stranger",
		email: "stranger@example.com",
		workspaceIds: [],
	},
};
type Person = keyof typeof people;

const spacesDatabase: SitesSpacesDatabase = {
	count: async () => 0,
	deleteDatabase: async () => undefined,
	deleteOwnerRecords: async () => 0,
	deleteRecord: async () => false,
	ensureForSite: async ({ id }) => ({
		databaseId: `database-${id}`,
		spaceId: `space-${id}`,
	}),
	importRecords: async () => undefined,
	ownerRecords: async () => [],
	ownerUsage: async () => [],
	query: async () => ({ columns: [], rows: [], schema: [], truncated: false }),
	records: async () => [],
	saveRecord: async () => undefined,
};

function harness() {
	const store = new SitesStore(":memory:");
	const server = createSitesServer({
		store,
		token: "core-token",
		port: 0,
		visitorPort: 0,
		publicEnabled: true,
		services: {
			identity: async () => null,
			invokeConnection: async () => ({}),
			managementIdentity: async (request) =>
				people[request.headers.get("x-test-person") ?? ""] ?? null,
			scanArtifact: async () => ({ allowed: true, reason: null }),
			spacesDatabase,
		},
	});
	cleanup.push(() => {
		server.stop();
		store.close();
	});
	const as =
		(person: Person) =>
		(path: string, method = "GET", body?: SiteDataValue) =>
			fetch(`http://127.0.0.1:${server.admin.port}/api/sites${path}`, {
				method,
				headers: {
					authorization: "Bearer core-token",
					"content-type": "application/json",
					"x-test-person": person,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
	return { store, server, as };
}

async function ok(response: Promise<Response>, status = 200) {
	const resolved = await response;
	if (resolved.status !== status) {
		throw new Error(`${resolved.status}: ${await resolved.text()}`);
	}
	return runtimeSiteSchema.parse(await resolved.json());
}

/** An owner Site with v1 deployed, a newer v2 saved, and owner-only state. */
async function sourceSite(h: ReturnType<typeof harness>) {
	const owner = h.as("owner");
	let site = await ok(
		owner("/projects", "POST", {
			name: "Source site",
			slug: "source-site",
			prompt: "Owner notes",
			template: "dashboard",
		}),
		201
	);
	const html = (label: string) => starterHtml(label, "dashboard", "");
	site = await ok(
		owner(`/projects/${site.id}/versions`, "POST", {
			html: html("Deployed"),
			expectedRevision: site.revision,
		}),
		201
	);
	const deployed = site.versions.at(-1)?.id ?? "";
	site = await ok(
		owner(`/projects/${site.id}/deploy`, "POST", {
			versionId: deployed,
			expectedRevision: site.revision,
		})
	);
	site = await ok(
		owner(`/projects/${site.id}/versions`, "POST", {
			html: html("Draft"),
			expectedRevision: site.revision,
		}),
		201
	);
	const latest = site.versions.at(-1)?.id ?? "";
	site = await ok(
		owner(`/projects/${site.id}/database/connect`, "POST", {
			expectedRevision: site.revision,
		})
	);
	site = await ok(
		owner(`/projects/${site.id}/domains`, "POST", {
			host: "source.example.com",
			expectedRevision: site.revision,
		})
	);
	site = await ok(
		owner(`/projects/${site.id}/url`, "PUT", {
			slug: "source-site-renamed",
			expectedRevision: site.revision,
		})
	);
	site = await ok(
		owner(`/projects/${site.id}/connections`, "PUT", {
			connections: [
				{
					id: "calendar",
					label: "Calendar",
					toolId: "calendar.read",
					readOnly: false,
				},
			],
			expectedRevision: site.revision,
		})
	);
	site = await ok(
		owner(`/projects/${site.id}/settings`, "PUT", {
			settings: {
				...site.settings,
				audience: "invited",
				workspaceId: null,
				viewers: ["viewer@example.com"],
				editors: [],
				mode: "connected",
				aiDailyLimit: 7,
				aiSystemPrompt: "Owner-only instructions",
				storage: true,
				uploads: true,
				optionalSignIn: true,
				sharedData: { enabled: true, write: "editors" },
			},
			expectedRevision: site.revision,
		})
	);
	return { site, deployed, latest };
}

async function allowRemix(
	h: ReturnType<typeof harness>,
	site: RuntimeSite,
	allow = true
) {
	return await ok(
		h.as("owner")(`/projects/${site.id}/settings`, "PUT", {
			settings: { ...site.settings, allowRemix: allow },
			expectedRevision: site.revision,
		})
	);
}

describe("remix and duplicate", () => {
	test("remixing is off by default and refuses without revealing hidden Sites", async () => {
		const h = harness();
		const { site } = await sourceSite(h);
		expect(site.settings.allowRemix).toBe(false);
		expect(siteSettings.parse({}).allowRemix).toBe(false);
		const body = { name: "Copy", slug: "copy-site" };
		const hidden = await h
			.as("stranger")(`/projects/${site.id}/remix`, "POST", body)
			.then((response) => response.json());
		const missing = await h
			.as("stranger")("/projects/does-not-exist/remix", "POST", body)
			.then((response) => response.json());
		// A Site the caller cannot visit is indistinguishable from none.
		expect(hidden).toEqual(missing);
		expect(hidden.error.code).toBe("not_found");
		const denied = await h.as("viewer")(
			`/projects/${site.id}/remix`,
			"POST",
			body
		);
		expect(denied.status).toBe(403);
		expect(
			await h
				.as("viewer")("/projects?scope=remixable")
				.then((r) => r.json())
		).toEqual([]);
		expect(h.store.list()).toHaveLength(1);
	});

	test("a visitor remixes the deployed version into a new private Site", async () => {
		const h = harness();
		const source = await sourceSite(h);
		const site = await allowRemix(h, source.site);
		const gallery = remixableSite.array().parse(
			await h
				.as("viewer")("/projects?scope=remixable")
				.then((r) => r.json())
		);
		expect(gallery).toEqual([
			{
				id: site.id,
				name: "Source site",
				slug: "source-site-renamed",
				template: "dashboard",
				deploymentId: source.deployed,
				updatedAt: site.updatedAt,
				access: "viewer",
			},
		]);
		// The gallery projection carries no access lists or bindings.
		expect(
			Object.keys(
				(
					await h
						.as("viewer")("/projects?scope=remixable")
						.then((r) => r.json())
				)[0]
			).sort()
		).toEqual(
			[
				"access",
				"deploymentId",
				"id",
				"name",
				"slug",
				"template",
				"updatedAt",
			].sort()
		);
		expect(
			await h
				.as("stranger")("/projects?scope=remixable")
				.then((r) => r.json())
		).toEqual([]);
		expect(
			await h
				.as("owner")("/projects?scope=remixable")
				.then((r) => r.json())
		).toEqual([]);

		const remixed = await ok(
			h.as("viewer")(`/projects/${site.id}/remix`, "POST", {
				name: "My remix",
				slug: "my-remix",
				expectedRevision: site.revision,
			}),
			201
		);
		expect(remixed.access).toBe("owner");
		expect(remixed.ownerId).toBe(people.viewer?.id ?? "");
		expect(remixed.id).not.toBe(site.id);
		expect(remixed.remixedFrom).toEqual({
			name: "Source site",
			siteId: site.id,
			versionId: source.deployed,
		});
		expect(remixed.template).toBe("dashboard");
		expect(remixed.prompt).toBe("");
		// Copied: the deployed HTML and the non-sensitive runtime choices.
		expect(remixed.versions).toHaveLength(1);
		const version = remixed.versions[0]?.id ?? "";
		expect(version).not.toBe(source.deployed);
		expect(h.store.artifact(remixed.id, version)).toBe(
			h.store.artifact(site.id, source.deployed)
		);
		expect(remixed.settings.mode).toBe("connected");
		expect(remixed.settings.aiDailyLimit).toBe(7);
		// Never copied: access, bindings, data, secrets, domains or aliases.
		expect(remixed.settings).toEqual({
			...siteSettings.parse({}),
			mode: "connected",
			aiDailyLimit: 7,
		});
		expect(remixed.settings.audience).toBe("private");
		expect(remixed.settings.viewers).toEqual([]);
		expect(remixed.settings.database).toBeNull();
		expect(remixed.settings.aiSystemPrompt).toBe("");
		expect(remixed.settings.allowRemix).toBe(false);
		expect(remixed.domains).toEqual([]);
		expect(remixed.aliases).toEqual([]);
		expect(remixed.connections).toEqual([]);
		expect(remixed.deploymentId).toBeNull();
		expect(remixed.hasPublished).toBe(false);
		// The new Site is listed as the caller's own, and the source is unchanged.
		const owned = runtimeSiteSchema.array().parse(
			await h
				.as("viewer")("/projects")
				.then((r) => r.json())
		);
		expect(owned.map((item) => item.id)).toEqual([remixed.id]);
		expect(h.store.get(site.id).revision).toBe(site.revision);
		// Visitor data never follows the copy.
		for (const table of [
			"records",
			"files",
			"traffic",
			"page_traffic",
			"connection_consents",
		]) {
			expect(
				h.store.db
					.query(`SELECT COUNT(*) AS count FROM ${table} WHERE site=?`)
					.get(remixed.id)
			).toEqual({ count: 0 });
		}
		expect(
			h.store.db
				.query(
					"SELECT actor, action, subject, detail FROM site_audit WHERE site=?"
				)
				.all(remixed.id)
		).toEqual([
			{
				actor: people.viewer?.id ?? "",
				action: REMIX_AUDIT_ACTION,
				subject: site.id,
				detail: JSON.stringify({
					kind: "remix",
					sourceVersionId: source.deployed,
				}),
			},
		]);
	});

	test("the owner duplicates the latest saved version without allowRemix", async () => {
		const h = harness();
		const { site, latest } = await sourceSite(h);
		const copy = await ok(
			h.as("owner")(`/projects/${site.id}/remix`, "POST", {
				name: "Source copy",
				slug: "source-copy",
			}),
			201
		);
		expect(copy.remixedFrom).toEqual({
			name: "Source site",
			siteId: site.id,
			versionId: latest,
		});
		expect(copy.settings.aiSystemPrompt).toBe("");
		expect(copy.settings.viewers).toEqual([]);
		expect(copy.settings.sharedData.enabled).toBe(false);
		expect(copy.settings.storage).toBe(false);
		expect(copy.settings.uploads).toBe(false);
		expect(copy.settings.optionalSignIn).toBe(false);
		expect(
			h.store.db
				.query("SELECT detail FROM site_audit WHERE site=? AND action=?")
				.get(copy.id, REMIX_AUDIT_ACTION)
		).toEqual({
			detail: JSON.stringify({ kind: "duplicate", sourceVersionId: latest }),
		});
	});

	test("a workspace editor duplicates the latest saved version from the gallery", async () => {
		const h = harness();
		const { site, latest, deployed } = await sourceSite(h);
		const shared = await ok(
			h.as("owner")(`/projects/${site.id}/settings`, "PUT", {
				settings: {
					...site.settings,
					allowRemix: true,
					workspaceId: "org-1",
					editors: ["editor@example.com"],
				},
				expectedRevision: site.revision,
			})
		);
		expect(latest).not.toBe(deployed);
		const gallery = remixableSite.array().parse(
			await h
				.as("editor")("/projects?scope=remixable")
				.then((r) => r.json())
		);
		expect(gallery.map((item) => [item.id, item.access])).toEqual([
			[shared.id, "editor"],
		]);
		const copy = await ok(
			h.as("editor")(`/projects/${shared.id}/remix`, "POST", {
				name: "Editor copy",
				slug: "editor-copy",
				expectedRevision: shared.revision,
			}),
			201
		);
		// The never-deployed draft, recorded as a duplicate, not a remix.
		expect(copy.remixedFrom?.versionId).toBe(latest);
		expect(copy.ownerId).toBe(people.editor?.id ?? "");
		expect(h.store.artifact(copy.id, copy.versions[0]?.id ?? "")).toBe(
			h.store.artifact(shared.id, latest)
		);
		expect(
			h.store.db
				.query("SELECT detail FROM site_audit WHERE site=? AND action=?")
				.get(copy.id, REMIX_AUDIT_ACTION)
		).toEqual({
			detail: JSON.stringify({ kind: "duplicate", sourceVersionId: latest }),
		});
	});

	test("refuses stale revisions, taken URLs, unpublished sources and invalid input", async () => {
		const h = harness();
		const source = await sourceSite(h);
		const site = await allowRemix(h, source.site);
		const remix = (body: SiteDataValue, person: Person = "viewer") =>
			h.as(person)(`/projects/${site.id}/remix`, "POST", body);
		expect(
			(
				await remix({
					name: "Stale",
					slug: "stale-site",
					expectedRevision: site.revision - 1,
				})
			).status
		).toBe(409);
		// The source's current URL and its old alias both stay reserved.
		expect(
			(await remix({ name: "Taken", slug: "source-site-renamed" })).status
		).toBe(409);
		expect((await remix({ name: "Taken", slug: "source-site" })).status).toBe(
			409
		);
		expect(
			(await remix({ name: "Extra", slug: "extra-site", settings: {} })).status
		).toBe(400);
		const unpublished = await ok(
			h.as("owner")(`/projects/${site.id}/unpublish`, "POST", {
				expectedRevision: site.revision,
			})
		);
		const refused = await remix({ name: "Late", slug: "late-site" });
		expect(refused.status).toBe(409);
		expect(
			await h
				.as("viewer")("/projects?scope=remixable")
				.then((r) => r.json())
		).toEqual([]);
		// The owner may still duplicate from the latest saved version.
		await ok(
			h.as("owner")(`/projects/${unpublished.id}/remix`, "POST", {
				name: "Owner copy",
				slug: "owner-copy",
			}),
			201
		);
		expect(h.store.list()).toHaveLength(2);
	});

	test("caps the remixes one person starts per day", async () => {
		const h = harness();
		const source = await sourceSite(h);
		const site = await allowRemix(h, source.site);
		for (let index = 0; index < SITE_LIMITS.remixesPerDay; index += 1) {
			await ok(
				h.as("viewer")(`/projects/${site.id}/remix`, "POST", {
					name: `Remix ${index}`,
					slug: `remix-number-${index}`,
				}),
				201
			);
		}
		const limited = await h.as("viewer")(`/projects/${site.id}/remix`, "POST", {
			name: "One more",
			slug: "one-more-remix",
		});
		expect(limited.status).toBe(429);
		expect((await limited.json()).error.code).toBe("quota");
	});

	test("deleting remixed copies does not refund the daily remix limit", async () => {
		const h = harness();
		const source = await sourceSite(h);
		const site = await allowRemix(h, source.site);
		const viewer = h.as("viewer");
		for (let index = 0; index < SITE_LIMITS.remixesPerDay; index += 1) {
			const copy = await ok(
				viewer(`/projects/${site.id}/remix`, "POST", {
					name: `Remix ${index}`,
					slug: `remix-number-${index}`,
				}),
				201
			);
			const deleted = await viewer(`/projects/${copy.id}`, "DELETE", {
				slug: copy.slug,
				expectedRevision: copy.revision,
			});
			expect(deleted.status).toBeLessThan(300);
		}
		// Only the source is left, yet the day's remixes are used up.
		expect(h.store.list().map((item) => item.id)).toEqual([site.id]);
		const limited = await viewer(`/projects/${site.id}/remix`, "POST", {
			name: "One more",
			slug: "one-more-remix",
		});
		expect(limited.status).toBe(429);
		expect((await limited.json()).error.code).toBe("quota");
		expect(h.store.list()).toHaveLength(1);
		// The limit is per person: another visitor still has their own.
		await ok(
			h.as("owner")(`/projects/${site.id}/remix`, "POST", {
				name: "Owner copy",
				slug: "owner-copy",
			}),
			201
		);
	});

	test("visitor pages learn only whether remixing is allowed", async () => {
		const h = harness();
		const owner = h.as("owner");
		let site = await ok(
			owner("/projects", "POST", { name: "Open", slug: "open-site" }),
			201
		);
		site = await ok(
			owner(`/projects/${site.id}/versions`, "POST", {
				html: starterHtml("Open", "website", ""),
				expectedRevision: site.revision,
			}),
			201
		);
		site = await ok(
			owner(`/projects/${site.id}/deploy`, "POST", {
				versionId: site.versions.at(-1)?.id ?? "",
				expectedRevision: site.revision,
			})
		);
		site = await ok(
			owner(`/projects/${site.id}/settings`, "PUT", {
				settings: { ...site.settings, audience: "public", allowRemix: true },
				expectedRevision: site.revision,
			})
		);
		const config = await fetch(
			`http://127.0.0.1:${h.server.visitor.port}/_ryu/config`,
			{ headers: { host: `open-site.localhost:${h.server.visitor.port}` } }
		).then((response) => response.json());
		expect(config.remixable).toBe(true);
		await allowRemix(h, site, false);
		const off = await fetch(
			`http://127.0.0.1:${h.server.visitor.port}/_ryu/config`,
			{ headers: { host: `open-site.localhost:${h.server.visitor.port}` } }
		).then((response) => response.json());
		expect(off.remixable).toBe(false);
	});
});
