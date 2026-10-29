import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITE_LIMITS } from "./contracts.ts";
import {
	createLocalSitesDatabase,
	LOCAL_DATABASE_SPACE_ID,
} from "./local-database.ts";
import { SitesStore } from "./store.ts";

const owner = { id: "owner", email: "owner@example.com", workspaceIds: [] };
const workDir = mkdtempSync(join(tmpdir(), "ryu-sites-local-db-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function seeded(queryTimeoutMs?: number) {
	const store = new SitesStore(":memory:");
	const site = store.create({ name: "Records", slug: "records-site" }, owner);
	const database = createLocalSitesDatabase({
		db: store.db,
		workDir,
		queryTimeoutMs,
	});
	return { store, site, database };
}

describe("local Sites database", () => {
	test("round-trips visitor records scoped by owner and collection", async () => {
		const { store, site, database } = seeded();
		const binding = await database.ensureForSite(site);
		expect(binding).toEqual({
			spaceId: LOCAL_DATABASE_SPACE_ID,
			databaseId: site.id,
		});
		await database.saveRecord(binding, {
			owner: "visitor-a",
			collection: "notes",
			key: "first",
			value: JSON.stringify({ text: "hello" }),
		});
		await database.saveRecord(binding, {
			owner: "visitor-a",
			collection: "notes",
			key: "first",
			value: JSON.stringify({ text: "updated" }),
		});
		await database.saveRecord(binding, {
			owner: "visitor-b",
			collection: "notes",
			key: "first",
			value: JSON.stringify("other visitor"),
		});
		expect(await database.records(binding, "visitor-a", "notes", null)).toEqual(
			[{ key: "first", value: { text: "updated" } }]
		);
		expect(
			await database.records(binding, "visitor-a", "notes", "missing")
		).toEqual([]);
		expect(await database.count(binding)).toBe(2);
		expect(
			await database.deleteRecord(binding, "visitor-a", "notes", "first")
		).toBe(true);
		expect(
			await database.deleteRecord(binding, "visitor-a", "notes", "first")
		).toBe(false);
		expect(await database.count(binding)).toBe(1);
		store.delete(site.id);
		expect(
			store.db
				.query("SELECT COUNT(*) AS count FROM site_database_records")
				.get()
		).toEqual({ count: 0 });
		store.close();
	});

	test("keeps the per-visitor and storage limits Ryu Spaces enforces", async () => {
		const { store, site, database } = seeded();
		const binding = await database.ensureForSite(site);
		for (let index = 0; index < SITE_LIMITS.recordsPerVisitor; index += 1) {
			await database.saveRecord(binding, {
				owner: "visitor",
				collection: "items",
				key: `item-${index}`,
				value: "1",
			});
		}
		await expect(
			database.saveRecord(binding, {
				owner: "visitor",
				collection: "items",
				key: "one-too-many",
				value: "1",
			})
		).rejects.toMatchObject({ code: "quota", status: 429 });
		// Replacing an existing record never counts as growth.
		await database.saveRecord(binding, {
			owner: "visitor",
			collection: "items",
			key: "item-0",
			value: "2",
		});
		const large = JSON.stringify("x".repeat(60_000));
		await database.saveRecord(binding, {
			owner: "writer",
			collection: "items",
			key: "one",
			value: large,
		});
		await expect(
			database.saveRecord(binding, {
				owner: "writer",
				collection: "items",
				key: "two",
				value: large,
			})
		).rejects.toMatchObject({ code: "quota", status: 429 });
		await expect(
			database.importRecords(
				binding,
				Array.from({ length: 25 }, (_, index) => ({
					owner: `imported-${index}`,
					collection: "items",
					key: "blob",
					value: large,
				}))
			)
		).rejects.toMatchObject({ code: "quota", status: 413 });
		expect(
			await database.records(binding, "imported-0", "items", null)
		).toEqual([]);
		store.close();
	});

	test("imports legacy records and deletes the Site database", async () => {
		const { store, site, database } = seeded();
		const binding = await database.ensureForSite(site);
		await database.importRecords(binding, [
			{ owner: "a", collection: "c", key: "k", value: "true" },
		]);
		expect(await database.records(binding, "a", "c", "k")).toEqual([
			{ key: "k", value: true },
		]);
		await database.deleteDatabase(binding);
		expect(await database.count(binding)).toBe(0);
		store.close();
	});

	test("reports and purges one visitor's records", async () => {
		const { store, site, database } = seeded();
		const binding = await database.ensureForSite(site);
		for (const [visitor, key] of [
			["visitor-a", "first"],
			["visitor-a", "second"],
			["visitor-b", "first"],
		] as const) {
			await database.saveRecord(binding, {
				owner: visitor,
				collection: "notes",
				key,
				value: JSON.stringify({ text: key }),
			});
		}
		const usage = await database.ownerUsage(binding);
		expect(usage.map(({ owner, records }) => ({ owner, records }))).toEqual([
			{ owner: "visitor-a", records: 2 },
			{ owner: "visitor-b", records: 1 },
		]);
		expect(usage.every((entry) => entry.bytes > 0)).toBe(true);
		expect(await database.deleteOwnerRecords(binding, "visitor-a")).toBe(2);
		expect(await database.deleteOwnerRecords(binding, "visitor-a")).toBe(0);
		expect(await database.records(binding, "visitor-b", "notes", null)).toEqual(
			[{ key: "first", value: { text: "first" } }]
		);
		expect(
			(await database.ownerUsage(binding)).map((entry) => entry.owner)
		).toEqual(["visitor-b"]);
		store.close();
	});

	test("refuses a binding to a Ryu Spaces database", async () => {
		const { store, database } = seeded();
		await expect(
			database.count({ spaceId: "space-1", databaseId: "database-1" })
		).rejects.toMatchObject({ code: "unavailable", status: 503 });
		store.close();
	});
});

describe("local Sites SQL console", () => {
	test("answers read-only queries over only the Site's own rows", async () => {
		const { store, site, database } = seeded();
		const other = store.create({ name: "Other", slug: "other-site" }, owner);
		const binding = await database.ensureForSite(site);
		const otherBinding = await database.ensureForSite(other);
		await database.saveRecord(binding, {
			owner: "a",
			collection: "c",
			key: "k",
			value: '"mine"',
		});
		await database.saveRecord(otherBinding, {
			owner: "b",
			collection: "c",
			key: "k",
			value: '"theirs"',
		});
		expect(
			await database.query(
				binding,
				"SELECT owner, value FROM data WHERE collection = ?",
				["c"]
			)
		).toEqual({
			columns: ["owner", "value"],
			rows: [["a", '"mine"']],
			schema: [
				{ id: "owner", label: "Owner", name: "owner" },
				{ id: "collection", label: "Collection", name: "collection" },
				{ id: "key", label: "Key", name: "key" },
				{ id: "value", label: "Value", name: "value" },
			],
			truncated: false,
		});
		expect(
			(await database.query(binding, "SELECT COUNT(*) AS total FROM data")).rows
		).toEqual([[1]]);
		store.close();
	});

	test("keeps the helper's sort and temp storage in memory", async () => {
		const { store, site, database } = seeded();
		const binding = await database.ensureForSite(site);
		// 2 = MEMORY: a large ORDER BY never spills decrypted rows to a temp file.
		expect(
			(
				await database.query(
					binding,
					"SELECT temp_store AS mode FROM pragma_temp_store"
				)
			).rows
		).toEqual([[2]]);
		// A sort larger than the 2 MB page cache still answers from memory.
		const sorted = await database.query(
			binding,
			"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 20000) SELECT x FROM c ORDER BY hex(randomblob(150)) || x"
		);
		expect(sorted.rows).toHaveLength(500);
		store.close();
	});

	test("refuses writes, multiple statements and other statements", async () => {
		const { store, site, database } = seeded();
		const binding = await database.ensureForSite(site);
		for (const statement of [
			"DELETE FROM data",
			"SELECT 1; DROP TABLE data",
			"ATTACH DATABASE 'x.sqlite' AS x",
			"",
		]) {
			await expect(database.query(binding, statement)).rejects.toMatchObject({
				code: "invalid_input",
			});
		}
		await expect(
			database.query(binding, "WITH x AS (SELECT 1) DELETE FROM data")
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(
			(await database.query(binding, "-- note\nSELECT ';' AS semi;")).rows
		).toEqual([[";"]]);
		store.close();
	});

	test("bounds results and stops a runaway query", async () => {
		const { store, site, database } = seeded(1500);
		const binding = await database.ensureForSite(site);
		const many = await database.query(
			binding,
			"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 600) SELECT x FROM c"
		);
		expect(many.rows).toHaveLength(500);
		expect(many.truncated).toBe(true);
		const started = performance.now();
		await expect(
			database.query(
				binding,
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c"
			)
		).rejects.toMatchObject({ code: "query_timeout" });
		expect(performance.now() - started).toBeLessThan(5000);
		await expect(
			database.query(binding, "SELECT length(hex(zeroblob(200000000)))")
		).rejects.toMatchObject({ code: "invalid_input" });
		// An oversized value is cut off before it is converted, well inside the
		// time budget, instead of running the helper until it is killed.
		expect(
			await database.query(binding, "SELECT randomblob(40000000) AS b")
		).toMatchObject({ rows: [], truncated: true });
		await expect(
			database.query(binding, "SELECT 1 AS a, 2 AS a")
		).rejects.toMatchObject({ code: "invalid_input" });
		expect((await database.query(binding, "SELECT 2 AS x")).rows).toEqual([
			[2],
		]);
		store.close();
	});
});
