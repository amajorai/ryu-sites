import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SitesStore } from "./store.ts";
import {
	loadVisitorQuotaKey,
	VISITOR_QUOTA_KEY_BYTES,
	VISITOR_QUOTA_KEY_FILE,
} from "./visitor-quota.ts";

const root = mkdtempSync(join(tmpdir(), "ryu-sites-quota-key-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let directories = 0;
function dataDirectory() {
	directories += 1;
	return join(root, `install-${directories}`, "sites");
}
const ownerOnly = process.platform !== "win32";

describe("visitor quota key", () => {
	test("stores sharing a data directory name a visitor the same way", () => {
		const directory = dataDirectory();
		const path = join(directory, "sites.sqlite");
		const first = new SitesStore(path);
		const before = first.visitorQuotaKey("site", "2026-10-13", "user:alice");
		first.close();
		const restarted = new SitesStore(path);
		expect(restarted.visitorQuotaKey("site", "2026-10-13", "user:alice")).toBe(
			before
		);
		expect(before).toMatch(/^[a-f0-9]{32}$/);
		expect(before).not.toContain("alice");
		// Unlinkable across days, Sites and visitors.
		for (const other of [
			restarted.visitorQuotaKey("site", "2026-10-14", "user:alice"),
			restarted.visitorQuotaKey("other-site", "2026-10-13", "user:alice"),
			restarted.visitorQuotaKey("site", "2026-10-13", "user:bob"),
		]) {
			expect(other).not.toBe(before);
		}
		restarted.close();
		const elsewhere = new SitesStore(join(dataDirectory(), "sites.sqlite"));
		expect(
			elsewhere.visitorQuotaKey("site", "2026-10-13", "user:alice")
		).not.toBe(before);
		elsewhere.close();
	});

	test("the key is created once, owner-only, and reused", () => {
		const directory = dataDirectory();
		mkdirSync(directory, { recursive: true });
		const path = join(directory, VISITOR_QUOTA_KEY_FILE);
		const key = loadVisitorQuotaKey(path);
		expect(key).toHaveLength(VISITOR_QUOTA_KEY_BYTES);
		expect(readFileSync(path).equals(key)).toBe(true);
		if (ownerOnly) {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			chmodSync(path, 0o644);
		}
		expect(loadVisitorQuotaKey(path).equals(key)).toBe(true);
		if (ownerOnly) {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(readdirSync(directory)).toEqual([VISITOR_QUOTA_KEY_FILE]);
	});

	test("processes starting together agree on one key", async () => {
		const directory = dataDirectory();
		mkdirSync(directory, { recursive: true });
		const path = join(directory, VISITOR_QUOTA_KEY_FILE);
		const module = join(import.meta.dir, "visitor-quota.ts");
		const script = `const { loadVisitorQuotaKey } = await import(${JSON.stringify(module)}); console.log(loadVisitorQuotaKey(${JSON.stringify(path)}).toString("hex"));`;
		const processes = Array.from({ length: 6 }, () =>
			Bun.spawn([process.execPath, "-e", script], {
				stdout: "pipe",
				stderr: "inherit",
			})
		);
		const keys = await Promise.all(
			processes.map(async (child) => {
				expect(await child.exited).toBe(0);
				return (await new Response(child.stdout).text()).trim();
			})
		);
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toBe(readFileSync(path).toString("hex"));
		expect(readdirSync(directory)).toEqual([VISITOR_QUOTA_KEY_FILE]);
	});

	test("a short or oversized key refuses startup instead of rotating", () => {
		for (const contents of [
			Buffer.alloc(0),
			Buffer.from("short"),
			Buffer.alloc(VISITOR_QUOTA_KEY_BYTES + 1, 7),
		]) {
			const directory = dataDirectory();
			mkdirSync(directory, { recursive: true });
			const path = join(directory, VISITOR_QUOTA_KEY_FILE);
			writeFileSync(path, contents);
			expect(() => new SitesStore(join(directory, "sites.sqlite"))).toThrow(
				"startup refused"
			);
			expect(readFileSync(path).equals(contents)).toBe(true);
			expect(readdirSync(directory)).toEqual([VISITOR_QUOTA_KEY_FILE]);
		}
	});

	test("an in-memory store keeps one key for its own lifetime", () => {
		const store = new SitesStore(":memory:");
		expect(
			store.visitorQuotaKey("site", "2026-10-13", "address:192.0.2.1")
		).toBe(store.visitorQuotaKey("site", "2026-10-13", "address:192.0.2.1"));
		store.close();
	});
});
