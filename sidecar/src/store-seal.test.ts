import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePluginKeys, type PluginKeys } from "@ryu/sidecar-runtime/seal";
import { createLocalSitesDatabase } from "./local-database.ts";
import { SitesStore } from "./store.ts";

const owner = { id: "owner", email: "owner@example.com", workspaceIds: [] };
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function keys(fill = 6): PluginKeys {
	return capturePluginKeys("@ryu/sites", {
		RYU_SEAL_KEY: Buffer.from(new Uint8Array(32).fill(fill)).toString("base64"),
		RYU_SEAL_SCOPE: "plugin:@ryu/sites",
	});
}

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ryu-sites-seal-"));
	roots.push(dir);
	return dir;
}

function disk(path: string): string {
	let text = readFileSync(path).toString("latin1");
	try {
		text += readFileSync(`${path}-wal`).toString("latin1");
	} catch {
		// No WAL.
	}
	return text;
}

const SECRETS = [
	"editor-secret@example.com",
	"legacy-record-secret",
	"database-record-secret",
	"legacy-file-name-secret",
	"legacy-file-bytes-secret",
];

describe("SitesStore sealing migration", () => {
	test("seals a version 4 plaintext store and keeps every reader working", async () => {
		const dir = tempDir();
		const path = join(dir, "sites.sqlite");
		const legacy = new SitesStore(path);
		const site = legacy.create({ name: "Docs", slug: "docs-site" }, owner);
		legacy.mutate(site.id, site.revision, (current) => {
			current.settings.editors = ["editor-secret@example.com"];
		});
		legacy.db
			.query(
				"INSERT INTO records(site, owner, collection, key, value) VALUES(?,?,?,?,?)"
			)
			.run(site.id, "visitor-a", "notes", "old", '"legacy-record-secret"');
		legacy.db
			.query(
				"INSERT INTO files(site, owner, id, name, type, data) VALUES(?,?,?,?,?,?)"
			)
			.run(
				site.id,
				"visitor-a",
				"file-1",
				"legacy-file-name-secret",
				"application/octet-stream",
				new TextEncoder().encode("legacy-file-bytes-secret")
			);
		const plainDb = createLocalSitesDatabase({ db: legacy.db, workDir: dir });
		const binding = await plainDb.ensureForSite(site);
		await plainDb.saveRecord(binding, {
			owner: "visitor-a",
			collection: "notes",
			key: "first",
			value: JSON.stringify("database-record-secret"),
		});
		legacy.db.exec("PRAGMA user_version=4");
		// A version 4 store has no size column yet.
		legacy.db.exec("ALTER TABLE files DROP COLUMN size");
		legacy.db.exec("ALTER TABLE records DROP COLUMN size");
		legacy.close();
		for (const secret of SECRETS) {
			expect(disk(path)).toContain(secret);
		}

		const sealed = new SitesStore(path, { keys: keys() });
		expect(sealed.get(site.id).settings.editors).toEqual([
			"editor-secret@example.com",
		]);
		expect(sealed.list()).toHaveLength(1);
		expect(sealed.legacyRecords(site.id)).toEqual([
			{
				owner: "visitor-a",
				collection: "notes",
				key: "old",
				value: '"legacy-record-secret"',
			},
		]);
		const file = sealed.db
			.query("SELECT data, size FROM files WHERE id='file-1'")
			.get() as { data: Uint8Array; size: number };
		expect(file.size).toBe("legacy-file-bytes-secret".length);
		expect(
			new TextDecoder().decode(
				sealed.seal.openBytes(
					{
						table: "files",
						column: "data",
						kind: "bytes",
						orderKey: "id",
						bind: ["id"],
					},
					{ id: "file-1" },
					file.data
				)
			)
		).toBe("legacy-file-bytes-secret");
		const database = createLocalSitesDatabase({
			db: sealed.db,
			workDir: dir,
			seal: sealed.seal,
		});
		expect(await database.records(binding, "visitor-a", "notes", null)).toEqual(
			[{ key: "first", value: "database-record-secret" }]
		);
		// The SQL console runs over opened values.
		const result = await database.query(
			binding,
			"SELECT value FROM data WHERE key = ?",
			["first"]
		);
		expect(JSON.stringify(result.rows)).toContain("database-record-secret");
		expect(sealed.seal.health()).toMatchObject({
			sealing: "ok",
			unreadableRows: 0,
			vacuumPending: false,
		});
		sealed.close();
		const text = disk(path);
		for (const secret of SECRETS) {
			expect(text).not.toContain(secret);
		}
	});

	test("seals visitor data an older build wrote after a rollback", () => {
		const dir = tempDir();
		const path = join(dir, "sites.sqlite");
		const store = new SitesStore(path, { keys: keys() });
		const site = store.create({ name: "Docs", slug: "docs-site" }, owner);
		store.close();
		// The pre-sealing build: plaintext rows, user_version set back to 4.
		const old = new Database(path);
		old
			.query(
				"INSERT INTO records(site, owner, collection, key, value) VALUES(?,?,?,?,?)"
			)
			.run(site.id, "visitor-a", "notes", "old", '"rollback-record-secret"');
		old
			.query(
				"INSERT INTO files(site, owner, id, name, type, data) VALUES(?,?,?,?,?,?)"
			)
			.run(
				site.id,
				"visitor-a",
				"file-rollback",
				"rollback-file-name-secret",
				"application/octet-stream",
				new TextEncoder().encode("rollback-file-bytes-secret")
			);
		old.exec("PRAGMA user_version=4");
		old.close();

		const reopened = new SitesStore(path, { keys: keys() });
		const file = reopened.db
			.query("SELECT name, data FROM files WHERE id='file-rollback'")
			.get() as { name: string; data: Uint8Array };
		expect(file.name.startsWith("encb:v1:")).toBe(true);
		expect(Buffer.from(file.data).subarray(0, 8).toString()).toBe("RYU-CB01");
		reopened.close();
		const text = disk(path);
		for (const secret of [
			"rollback-record-secret",
			"rollback-file-name-secret",
			"rollback-file-bytes-secret",
		]) {
			expect(text).not.toContain(secret);
		}
	});

	test("skips a Site whose state does not open in the list", () => {
		const dir = tempDir();
		const store = new SitesStore(join(dir, "sites.sqlite"), { keys: keys() });
		const first = store.create({ name: "One", slug: "one-site" }, owner);
		const second = store.create({ name: "Two", slug: "two-site" }, owner);
		const stored = store.db
			.query("SELECT state FROM sites WHERE id=?")
			.get(first.id) as { state: string };
		store.db
			.query("UPDATE sites SET state=? WHERE id=?")
			.run(stored.state, second.id);
		expect(store.list().map((site) => site.id)).toEqual([first.id]);
		expect(store.seal.unreadableRows).toBe(1);
		expect(() => store.get(second.id)).toThrow();
		store.close();
	});
});
