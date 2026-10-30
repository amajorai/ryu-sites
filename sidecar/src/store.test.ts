import { expect, test } from "bun:test";
import {
	SitesStore,
	TRAFFIC_PAGES_PER_DAY,
	TRAFFIC_PATHS_PER_DAY,
	TRAFFIC_VISITORS_PER_DAY,
} from "./store.ts";

const owner = { id: "owner", email: "owner@example.com", workspaceIds: [] };

function seeded() {
	const store = new SitesStore(":memory:");
	const site = store.create({ name: "Traffic", slug: "traffic-site" }, owner);
	return { store, site };
}

test("page views cap distinct paths per Site per day", () => {
	const { store, site } = seeded();
	const day = new Date().toISOString().slice(0, 10);
	const insert = store.db.query("INSERT INTO page_traffic VALUES(?,?,?,?,1)");
	store.db.transaction(() => {
		for (let index = 0; index < TRAFFIC_PATHS_PER_DAY; index += 1) {
			insert.run(site.id, day, "seed", `/seed-${index}`);
		}
	})();
	store.recordPageView(site.id, day, "visitor", "/seed-3");
	store.recordPageView(site.id, day, "visitor", "/brand-new-path");
	store.recordPageView(site.id, day, "visitor", "/another-new-path");
	const rows = store.db
		.query("SELECT path, views FROM page_traffic WHERE visitor='visitor'")
		.all();
	expect(rows).toEqual([
		{ path: "/seed-3", views: 1 },
		{ path: "(other)", views: 2 },
	]);
	store.close();
});

test("page views cap distinct visitors per Site per day", () => {
	const { store, site } = seeded();
	const day = new Date().toISOString().slice(0, 10);
	const insert = store.db.query("INSERT INTO traffic VALUES(?,?,?,1)");
	store.db.transaction(() => {
		for (let index = 0; index < TRAFFIC_VISITORS_PER_DAY; index += 1) {
			insert.run(site.id, day, `seed-${index}`);
		}
	})();
	store.recordPageView(site.id, day, "seed-7", "/");
	store.recordPageView(site.id, day, "late-visitor", "/");
	expect(
		store.db
			.query("SELECT visitor, views FROM traffic WHERE visitor IN (?,?,?)")
			.all("seed-7", "late-visitor", "(overflow)")
	).toEqual([
		{ visitor: "seed-7", views: 2 },
		{ visitor: "(overflow)", views: 1 },
	]);
	store.close();
});

test("rotating user agents and paths cannot grow page analytics past the daily pair cap", () => {
	const { store, site } = seeded();
	const day = new Date().toISOString().slice(0, 10);
	const insert = store.db.query("INSERT INTO page_traffic VALUES(?,?,?,?,1)");
	store.db.transaction(() => {
		for (let index = 0; index < TRAFFIC_PAGES_PER_DAY; index += 1) {
			insert.run(site.id, day, `seed-${index}`, `/seed-${index % 10}`);
		}
	})();
	// Each view looks like a new visitor (a fresh user agent) on a known path.
	for (let index = 0; index < 25; index += 1) {
		store.recordPageView(site.id, day, `rotating-${index}`, "/seed-3");
	}
	const pairs = (visitor: string) =>
		store.db
			.query(
				"SELECT path, views FROM page_traffic WHERE site=? AND day=? AND visitor=?"
			)
			.all(site.id, day, visitor);
	expect(pairs("rotating-0")).toEqual([]);
	expect(pairs("(overflow)")).toEqual([{ path: "/seed-3", views: 25 }]);
	expect(
		store.db
			.query("SELECT COUNT(*) AS count FROM page_traffic WHERE site=?")
			.get(site.id)
	).toEqual({ count: TRAFFIC_PAGES_PER_DAY + 1 });
	// Daily unique visitors are still counted while under the visitor cap.
	expect(
		store.db
			.query("SELECT COUNT(*) AS count FROM traffic WHERE site=?")
			.get(site.id)
	).toEqual({ count: 25 });
	store.close();
});

test("traffic retention pruning runs once per day and uses the day indexes", () => {
	const { store, site } = seeded();
	const day = "2026-10-10";
	const insertTraffic = store.db.query("INSERT INTO traffic VALUES(?,?,?,1)");
	insertTraffic.run(site.id, "2026-07-01", "old");
	store.recordPageView(site.id, day, "visitor", "/");
	expect(
		store.db.query("SELECT * FROM traffic WHERE day<'2026-07-12'").all()
	).toHaveLength(0);
	insertTraffic.run(site.id, "2026-07-02", "later-old");
	store.recordPageView(site.id, day, "visitor", "/");
	expect(
		store.db.query("SELECT * FROM traffic WHERE day<'2026-07-12'").all()
	).toHaveLength(1);
	store.recordPageView(site.id, "2026-10-11", "visitor", "/");
	expect(
		store.db.query("SELECT * FROM traffic WHERE day<'2026-07-12'").all()
	).toHaveLength(0);
	for (const table of ["traffic", "page_traffic"]) {
		const plan = store.db
			.query(`EXPLAIN QUERY PLAN DELETE FROM ${table} WHERE day<?`)
			.all("2026-07-12");
		expect(JSON.stringify(plan)).toContain(`${table}_day`);
	}
	store.close();
});
