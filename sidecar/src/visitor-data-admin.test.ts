import { describe, expect, test } from "bun:test";
import type { SitePrincipal } from "./contracts.ts";
import type { SitesSpacesDatabase } from "./spaces-database.ts";
import { SitesStore } from "./store.ts";
import {
	listVisitorData,
	purgeVisitorData,
	VISITOR_AUDIT_RETAINED,
	visitorKey,
	visitorOwner,
} from "./visitor-data-admin.ts";

const owner: SitePrincipal = { id: "owner", email: "", workspaceIds: [] };

describe("visitor keys", () => {
	test("round-trip account IDs as one URL-safe path segment", () => {
		for (const id of ["visitor-a", "auth0|123/456", "Bearer visitor-a", "ü"]) {
			const key = visitorKey(id);
			expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(visitorOwner(key)).toBe(id);
		}
	});

	test("refuse non-canonical, empty, oversized and control-character keys", () => {
		for (const key of [
			"",
			"QR",
			"QQ==",
			"a.b",
			visitorKey("a\u0007b"),
			visitorKey("x".repeat(513)),
		]) {
			expect(() => visitorOwner(key)).toThrow("Choose a visitor from the list");
		}
	});
});

describe("visitor data purge", () => {
	test("refuses before deleting anything when the records database is unreachable", async () => {
		const store = new SitesStore(":memory:");
		const site = store.create({ name: "Docs", slug: "docs-site" }, owner);
		store.mutate(site.id, site.revision, (current) => {
			current.settings.database = { spaceId: "space", databaseId: "db" };
		});
		store.db
			.query(
				"INSERT INTO files(site, owner, id, name, type, data, size) VALUES(?,?,?,?,?,?,?)"
			)
			.run(site.id, "visitor-a", "file-1", "a.txt", "text/plain", "hello", 5);
		const connected = store.get(site.id);
		const context = {
			database: undefined,
			databaseLabel: "a Ryu Spaces database",
			site: connected,
			store,
		};
		await expect(listVisitorData(context)).rejects.toMatchObject({
			status: 503,
		});
		await expect(
			purgeVisitorData({ ...context, actor: "owner", owner: "visitor-a" })
		).rejects.toMatchObject({ status: 503 });
		expect(store.db.query("SELECT COUNT(*) AS count FROM files").get()).toEqual(
			{ count: 1 }
		);
		expect(
			store.db.query("SELECT COUNT(*) AS count FROM site_audit").get()
		).toEqual({ count: 0 });
		store.close();
	});

	test("a failed record deletion leaves files and the audit untouched", async () => {
		const store = new SitesStore(":memory:");
		const site = store.create({ name: "Docs", slug: "docs-site" }, owner);
		store.mutate(site.id, site.revision, (current) => {
			current.settings.database = { spaceId: "space", databaseId: "db" };
		});
		store.db
			.query(
				"INSERT INTO files(site, owner, id, name, type, data, size) VALUES(?,?,?,?,?,?,?)"
			)
			.run(site.id, "visitor-a", "file-1", "a.txt", "text/plain", "hello", 5);
		const failing = {
			ownerRecords: () => Promise.resolve([]),
			deleteOwnerRecords: () => Promise.reject(new Error("Spaces is down")),
		} as Pick<SitesSpacesDatabase, "deleteOwnerRecords" | "ownerRecords">;
		await expect(
			purgeVisitorData({
				actor: "owner",
				database: failing as SitesSpacesDatabase,
				databaseLabel: "a Ryu Spaces database",
				owner: "visitor-a",
				site: store.get(site.id),
				store,
			})
		).rejects.toThrow("Spaces is down");
		expect(store.db.query("SELECT COUNT(*) AS count FROM files").get()).toEqual(
			{ count: 1 }
		);
		expect(
			store.db.query("SELECT COUNT(*) AS count FROM site_audit").get()
		).toEqual({ count: 0 });
		store.close();
	});

	test("purges legacy records and keeps a bounded audit trail", async () => {
		const store = new SitesStore(":memory:");
		const site = store.create({ name: "Docs", slug: "docs-site" }, owner);
		store.db
			.query(
				"INSERT INTO records(site, owner, collection, key, value) VALUES(?,?,?,?,?)"
			)
			.run(site.id, "visitor-a", "notes", "first", '"legacy"');
		const context = {
			database: undefined,
			databaseLabel: "the Site database",
			site,
			store,
		};
		expect((await listVisitorData(context)).visitors).toEqual([
			{
				visitor: visitorKey("visitor-a"),
				owner: "visitor-a",
				files: 0,
				fileBytes: 0,
				records: 1,
				recordBytes: 8,
				sharedRecords: 0,
			},
		]);
		const audit = await purgeVisitorData({
			...context,
			actor: "owner",
			owner: "visitor-a",
		});
		expect(audit).toMatchObject({ actor: "owner", files: 0, records: 1 });
		expect(store.legacyRecords(site.id)).toEqual([]);
		for (let index = 0; index < VISITOR_AUDIT_RETAINED + 5; index += 1) {
			await purgeVisitorData({ ...context, actor: "owner", owner: "nobody" });
		}
		expect(
			store.db
				.query("SELECT COUNT(*) AS count FROM site_audit WHERE site=?")
				.get(site.id)
		).toEqual({ count: VISITOR_AUDIT_RETAINED });
		expect((await listVisitorData(context)).audit).toHaveLength(20);
		store.close();
	});
});
