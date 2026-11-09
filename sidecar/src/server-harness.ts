/**
 * Shared harness for the Sites server tests: a management and visitor server
 * over an in-memory store with stub Ryu Spaces services.
 */
import type { RuntimeSite } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createSitesServer, type SitesServices } from "./server.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import type {
	LegacySiteRecord,
	SitesSpacesDatabase,
} from "./spaces-database.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";

/** Teardown shared by the Sites server test files. */
export const cleanup: (() => void)[] = [];
/**
 * Runs and clears the registered teardown, last in first out: a test registers
 * its folder before the harness that opens a database inside it, and Windows
 * cannot remove a folder while that database is open. Bun may run sibling
 * tests concurrently, so the files clean up once in `afterAll` instead of
 * after each test, which could stop another test's in-flight server.
 */
export function runCleanup() {
	for (const close of cleanup.splice(0).reverse()) {
		close();
	}
}
export function harness(
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
export async function create(
	h: ReturnType<typeof harness>,
	slug = "test-site"
) {
	const response = await h.admin("/projects", "POST", {
		name: "Test site",
		slug,
	});
	if (response.status !== 201) {
		throw new Error(await response.text());
	}
	return runtimeSiteSchema.parse(await response.json());
}
export async function save(
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
export async function deploy(h: ReturnType<typeof harness>, site: RuntimeSite) {
	const response = await h.admin(`/projects/${site.id}/deploy`, "POST", {
		versionId: site.versions.at(-1)?.id,
		expectedRevision: site.revision,
	});
	if (response.status !== 200) {
		throw new Error(await response.text());
	}
	return runtimeSiteSchema.parse(await response.json());
}
export async function publish(
	h: ReturnType<typeof harness>,
	site: RuntimeSite
) {
	const response = await h.admin(`/projects/${site.id}/settings`, "PUT", {
		settings: { ...site.settings, audience: "public" },
		expectedRevision: site.revision,
	});
	if (response.status !== 200) {
		throw new Error(await response.text());
	}
	return runtimeSiteSchema.parse(await response.json());
}
