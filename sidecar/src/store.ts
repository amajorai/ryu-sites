import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type SealedColumn,
	StoreSeal,
} from "@ryu/sidecar-runtime/content-seal";
import type { PluginKeys } from "@ryu/sidecar-runtime/seal";
import { z } from "zod";
import {
	createSiteInput,
	type RuntimeSite,
	remixSettings,
	type remixSiteInput,
	SITE_LIMITS,
	type SitePrincipal,
	siteSettings,
} from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import {
	artifactRowSchema,
	legacyRecordsSchema,
	readStoredSite,
	stateRowSchema,
} from "./site-records.ts";
import {
	loadVisitorQuotaKey,
	VISITOR_QUOTA_KEY_BYTES,
	VISITOR_QUOTA_KEY_FILE,
	visitorQuotaKey,
} from "./visitor-quota.ts";

/** Days of analytics kept; older traffic rows are pruned once per day. */
export const TRAFFIC_RETENTION_DAYS = 90;
/** Distinct page paths recorded per Site per day; later paths count as "(other)". */
export const TRAFFIC_PATHS_PER_DAY = 1000;
/** Visitor digests recorded per Site per day; later visitors share one bucket. */
export const TRAFFIC_VISITORS_PER_DAY = 20_000;
/**
 * Visitor and page pairs recorded per Site per day. Visitor digests include
 * the client-chosen user agent, so without this bound one client could pair
 * every allowed visitor with every allowed path. Later pairs keep their path
 * but share the overflow visitor.
 */
export const TRAFFIC_PAGES_PER_DAY = 50_000;
const OTHER_PATH = "(other)";
const OVERFLOW_VISITOR = "(overflow)";
const countRowSchema = z.object({ count: z.number() });
interface DailyTraffic {
	pages: number;
	paths: number;
	visitors: number;
}

/** Registered content-store name (KDF input; never renamed). */
export const SITES_CONTENT_STORE = "sites.sqlite";

/** Site state (owner, viewer and editor emails, settings): one `encb:v1:` per Site. */
export const SITE_STATE: SealedColumn = {
	table: "sites",
	column: "state",
	kind: "text",
	orderKey: "id",
	bind: ["id"],
};
/** Visitor uploads: `RYU-CB01` bytes; `files.size` keeps the plaintext length. */
export const FILE_DATA: SealedColumn = {
	table: "files",
	column: "data",
	kind: "bytes",
	orderKey: "id",
	bind: ["id"],
};
export const FILE_NAME: SealedColumn = {
	table: "files",
	column: "name",
	kind: "text",
	orderKey: "id",
	bind: ["id"],
};
/**
 * Durable visitor records. These tables have no id column: the AAD binds the
 * composite primary key, and the migration cursor walks the rowid (never bound).
 */
export const DATABASE_RECORD_VALUE: SealedColumn = {
	table: "site_database_records",
	column: "value",
	kind: "text",
	orderKey: "rowid",
	bind: ["site", "owner", "collection", "key"],
};
/** Legacy (pre-database) visitor records, read until they are imported. */
export const LEGACY_RECORD_VALUE: SealedColumn = {
	table: "records",
	column: "value",
	kind: "text",
	orderKey: "rowid",
	bind: ["site", "owner", "collection", "key"],
};

/** Standalone durable visitor records (see `local-database.ts`). */
export const SITE_DATABASE_RECORDS_DDL = `CREATE TABLE IF NOT EXISTS site_database_records (
		site TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
		owner TEXT NOT NULL,
		collection TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		bytes INTEGER NOT NULL,
		PRIMARY KEY(site, owner, collection, key)
	)`;

export interface SitesStoreOptions {
	/** The app's captured keys; omitted (tests, tools) keeps plaintext. */
	keys?: PluginKeys | null;
}

export class SiteError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400
	) {
		super(message);
	}
}

export class SitesStore {
	readonly db: Database;
	private prunedDay = "";
	// Today's bounded counts per Site, read once and then kept current so a
	// page view never rescans the day's analytics rows.
	private trafficDay = "";
	private readonly dailyTraffic = new Map<string, DailyTraffic>();
	// Names visitors in `operation_usage`. It lives beside the database, so a
	// restart keeps each visitor's daily share; an in-memory database gets a
	// key that lasts exactly as long as its counters.
	private readonly quotaKey: Buffer;
	/** Per-value sealing of visitor data and Site state. */
	readonly seal: StoreSeal;
	constructor(path: string, options: SitesStoreOptions = {}) {
		if (path === ":memory:") {
			this.quotaKey = randomBytes(VISITOR_QUOTA_KEY_BYTES);
		} else {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			this.quotaKey = loadVisitorQuotaKey(
				join(dirname(path), VISITOR_QUOTA_KEY_FILE)
			);
		}
		this.db = new Database(path, { create: true });
		if (path !== ":memory:") {
			chmodSync(path, 0o600);
		}
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
		CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, state TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS artifacts (site TEXT REFERENCES sites(id) ON DELETE CASCADE, id TEXT PRIMARY KEY, html TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS records (site TEXT REFERENCES sites(id) ON DELETE CASCADE, owner TEXT, collection TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(site,owner,collection,key));
		CREATE TABLE IF NOT EXISTS files (site TEXT REFERENCES sites(id) ON DELETE CASCADE, owner TEXT, id TEXT PRIMARY KEY, name TEXT, type TEXT, data BLOB);
		CREATE TABLE IF NOT EXISTS operation_usage (site TEXT REFERENCES sites(id) ON DELETE CASCADE, day TEXT, kind TEXT, count INTEGER, PRIMARY KEY(site,day,kind));
		CREATE TABLE IF NOT EXISTS traffic (site TEXT REFERENCES sites(id) ON DELETE CASCADE, day TEXT, visitor TEXT, views INTEGER, PRIMARY KEY(site,day,visitor));
		CREATE TABLE IF NOT EXISTS page_traffic (site TEXT REFERENCES sites(id) ON DELETE CASCADE, day TEXT, visitor TEXT, path TEXT, views INTEGER, PRIMARY KEY(site,day,visitor,path));
		CREATE TABLE IF NOT EXISTS connection_consents (site TEXT REFERENCES sites(id) ON DELETE CASCADE, owner TEXT, connection TEXT, revision TEXT, PRIMARY KEY(site,owner,connection));
		CREATE TABLE IF NOT EXISTS site_audit (site TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS remix_usage (actor TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(actor,day));
		CREATE INDEX IF NOT EXISTS files_owner ON files(site,owner);
		CREATE INDEX IF NOT EXISTS site_audit_site ON site_audit(site,at);
		CREATE INDEX IF NOT EXISTS traffic_day ON traffic(day);
		CREATE INDEX IF NOT EXISTS page_traffic_day ON page_traffic(day);
		CREATE INDEX IF NOT EXISTS page_traffic_path ON page_traffic(site,day,path);
		CREATE INDEX IF NOT EXISTS operation_usage_day ON operation_usage(day);`);
		this.db.exec(SITE_DATABASE_RECORDS_DDL);
		// Version 5: quota queries read a plaintext `size` (sealed bytes are
		// longer than the upload), backfilled before any value is sealed.
		for (const table of ["files", "records"]) {
			const columns = this.db.query(`PRAGMA table_info(${table})`).all() as {
				name: string;
			}[];
			if (!columns.some((column) => column.name === "size")) {
				this.db.exec(`ALTER TABLE ${table} ADD COLUMN size INTEGER`);
			}
		}
		this.db.exec(`UPDATE files SET size=LENGTH(data) WHERE size IS NULL;
		UPDATE records SET size=LENGTH(value) WHERE size IS NULL;`);
		this.seal = StoreSeal.open(
			this.db,
			path === ":memory:" ? null : path,
			SITES_CONTENT_STORE,
			options.keys ?? null,
			[
				SITE_STATE,
				FILE_NAME,
				FILE_DATA,
				DATABASE_RECORD_VALUE,
				LEGACY_RECORD_VALUE,
			]
		);
		this.db.exec("PRAGMA user_version=5");
	}
	private sealState(site: RuntimeSite): string {
		return this.seal.sealText(
			SITE_STATE,
			{ id: site.id },
			JSON.stringify(site)
		);
	}
	list(): RuntimeSite[] {
		const rows = this.db
			.query("SELECT id, state FROM sites ORDER BY rowid DESC")
			.all() as { id: string; state: unknown }[];
		const sites: RuntimeSite[] = [];
		for (const row of rows) {
			const { state } = stateRowSchema.parse(row);
			// A Site whose state does not open is skipped and counted.
			const opened = this.seal.tryOpenText(SITE_STATE, { id: row.id }, state);
			if (opened !== null) {
				sites.push(readStoredSite(opened));
			}
		}
		return sites;
	}
	get(id: string): RuntimeSite {
		const row = stateRowSchema
			.nullable()
			.parse(this.db.query("SELECT state FROM sites WHERE id=?").get(id));
		if (!row) {
			throw new SiteError("not_found", "Site not found", 404);
		}
		return readStoredSite(this.seal.openText(SITE_STATE, { id }, row.state));
	}
	create(input: SiteDataValue, owner: SitePrincipal): RuntimeSite {
		const parsed = createSiteInput.parse(input);
		const site = this.newSite(parsed, owner);
		this.db.transaction(() => {
			this.assertCanCreate(parsed.slug);
			this.insertSite(site);
		})();
		return site;
	}
	/**
	 * Starts a new private Site owned by `owner` from one saved artifact of
	 * `source`. Only the artifact, the template and the settings
	 * `remixSettings` allows are copied; domains, aliases, access lists,
	 * connections, consents, records, files, shared data and analytics are not.
	 */
	remix(
		source: RuntimeSite,
		versionId: string,
		input: z.output<typeof remixSiteInput>,
		owner: SitePrincipal
	): RuntimeSite {
		const html = this.artifact(source.id, versionId);
		const bytes = new TextEncoder().encode(html).length;
		const site = this.newSite(
			{
				name: input.name,
				slug: input.slug,
				prompt: "",
				template: source.template,
			},
			owner
		);
		site.settings = remixSettings(source.settings);
		site.remixedFrom = { name: source.name, siteId: source.id, versionId };
		const version = crypto.randomUUID();
		site.versions.push({
			bytes,
			commit: null,
			createdAt: site.createdAt,
			extensions: structuredClone(site.settings.extensions),
			id: version,
			message: `Remixed from ${source.name}`.slice(0, 500),
		});
		this.db.transaction(() => {
			this.assertCanCreate(input.slug);
			// Counted apart from `sites`, so deleting a copy never refunds it.
			const today = site.createdAt.slice(0, 10);
			const started =
				countRowSchema
					.nullable()
					.parse(
						this.db
							.query("SELECT count FROM remix_usage WHERE actor=? AND day=?")
							.get(owner.id, today)
					)?.count ?? 0;
			if (started >= SITE_LIMITS.remixesPerDay) {
				throw new SiteError(
					"quota",
					"Daily remix limit reached. Try again tomorrow.",
					429
				);
			}
			this.insertSite(site);
			this.db
				.query(
					"INSERT INTO remix_usage VALUES(?,?,1) ON CONFLICT(actor,day) DO UPDATE SET count=count+1"
				)
				.run(owner.id, today);
			this.db
				.query("INSERT INTO artifacts VALUES(?,?,?)")
				.run(site.id, version, html);
		})();
		return site;
	}
	private newSite(
		parsed: z.output<typeof createSiteInput>,
		owner: SitePrincipal
	): RuntimeSite {
		const now = new Date().toISOString();
		return {
			...parsed,
			id: crypto.randomUUID(),
			ownerId: owner.id,
			schemaVersion: 1,
			createdAt: now,
			updatedAt: now,
			revision: 0,
			settings: siteSettings.parse({}),
			versions: [],
			deploymentId: null,
			hasPublished: false,
			domains: [],
			aliases: [],
			connections: [],
		};
	}
	private assertCanCreate(slug: string) {
		if (this.list().length >= SITE_LIMITS.projects) {
			throw new SiteError("quota", "Project limit reached", 429);
		}
		this.assertSlugAvailable(slug);
	}
	private insertSite(site: RuntimeSite) {
		this.db
			.query("INSERT INTO sites VALUES(?,?,?)")
			.run(site.id, site.slug, this.sealState(site));
	}
	assertSlugAvailable(slug: string, except?: string) {
		if (
			this.list().some(
				(site) =>
					site.id !== except &&
					(site.slug === slug || site.aliases.includes(slug))
			)
		) {
			throw new SiteError("conflict", "This URL is already in use", 409);
		}
	}
	mutate(
		id: string,
		revision: number,
		update: (site: RuntimeSite) => void
	): RuntimeSite {
		return this.db.transaction(() => {
			const site = this.get(id);
			if (site.revision !== revision) {
				throw new SiteError(
					"conflict",
					"Site changed. Reload before saving.",
					409
				);
			}
			update(site);
			site.revision += 1;
			site.updatedAt = new Date().toISOString();
			this.db
				.query("UPDATE sites SET slug=?, state=? WHERE id=?")
				.run(site.slug, this.sealState(site), id);
			return site;
		})();
	}
	artifact(site: string, version: string): string {
		const row = artifactRowSchema
			.nullable()
			.parse(
				this.db
					.query("SELECT html FROM artifacts WHERE site=? AND id=?")
					.get(site, version)
			);
		if (!row) {
			throw new SiteError("not_found", "Saved version not found", 404);
		}
		return row.html;
	}
	private dailyCounts(site: string, day: string): DailyTraffic {
		if (this.trafficDay !== day) {
			this.trafficDay = day;
			this.dailyTraffic.clear();
		}
		const cached = this.dailyTraffic.get(site);
		if (cached) {
			return cached;
		}
		const count = (sql: string) =>
			countRowSchema.parse(this.db.query(sql).get(site, day)).count;
		const counts = {
			pages: count(
				"SELECT COUNT(*) AS count FROM page_traffic WHERE site=? AND day=?"
			),
			paths: count(
				"SELECT COUNT(DISTINCT path) AS count FROM page_traffic WHERE site=? AND day=?"
			),
			visitors: count(
				"SELECT COUNT(*) AS count FROM traffic WHERE site=? AND day=?"
			),
		};
		this.dailyTraffic.set(site, counts);
		return counts;
	}
	/**
	 * Records one page view with bounded growth: distinct paths, visitor
	 * digests and visitor and page pairs per Site per day are capped, and
	 * retention pruning runs once per day instead of on every request.
	 */
	recordPageView(site: string, day: string, visitor: string, path: string) {
		this.db.transaction(() => {
			const counts = this.dailyCounts(site, day);
			const newVisitor = !this.db
				.query("SELECT 1 FROM traffic WHERE site=? AND day=? AND visitor=?")
				.get(site, day, visitor);
			const visitorKey =
				newVisitor && counts.visitors >= TRAFFIC_VISITORS_PER_DAY
					? OVERFLOW_VISITOR
					: visitor;
			const newPath = !this.db
				.query(
					"SELECT 1 FROM page_traffic WHERE site=? AND day=? AND path=? LIMIT 1"
				)
				.get(site, day, path);
			const pathKey =
				newPath && counts.paths >= TRAFFIC_PATHS_PER_DAY ? OTHER_PATH : path;
			const newPage = !this.db
				.query(
					"SELECT 1 FROM page_traffic WHERE site=? AND day=? AND visitor=? AND path=?"
				)
				.get(site, day, visitorKey, pathKey);
			const pageVisitor =
				newPage && counts.pages >= TRAFFIC_PAGES_PER_DAY
					? OVERFLOW_VISITOR
					: visitorKey;
			this.db
				.query(
					"INSERT INTO traffic VALUES(?,?,?,1) ON CONFLICT(site,day,visitor) DO UPDATE SET views=views+1"
				)
				.run(site, day, visitorKey);
			this.db
				.query(
					"INSERT INTO page_traffic VALUES(?,?,?,?,1) ON CONFLICT(site,day,visitor,path) DO UPDATE SET views=views+1"
				)
				.run(site, day, pageVisitor, pathKey);
			if (visitorKey === visitor && newVisitor) {
				counts.visitors += 1;
			}
			if (pathKey === path && newPath) {
				counts.paths += 1;
			}
			if (pageVisitor === visitorKey && newPage) {
				counts.pages += 1;
			}
		})();
		this.pruneUsage(day);
	}
	/** The `operation_usage` kind suffix for one visitor's share on one UTC day. */
	visitorQuotaKey(site: string, day: string, visitor: string): string {
		return visitorQuotaKey(this.quotaKey, site, day, visitor);
	}
	/** Drops expired analytics and usage counters at most once per day. */
	pruneUsage(day: string) {
		if (this.prunedDay === day) {
			return;
		}
		this.prunedDay = day;
		const today = Date.parse(`${day}T00:00:00Z`);
		const trafficCutoff = new Date(today - TRAFFIC_RETENTION_DAYS * 86_400_000)
			.toISOString()
			.slice(0, 10);
		const usageCutoff = new Date(today - 2 * 86_400_000)
			.toISOString()
			.slice(0, 10);
		this.db.query("DELETE FROM traffic WHERE day<?").run(trafficCutoff);
		this.db.query("DELETE FROM page_traffic WHERE day<?").run(trafficCutoff);
		this.db.query("DELETE FROM operation_usage WHERE day<?").run(usageCutoff);
		this.db.query("DELETE FROM remix_usage WHERE day<?").run(usageCutoff);
	}
	legacyRecords(site: string): {
		collection: string;
		key: string;
		owner: string;
		value: string;
	}[] {
		const rows = legacyRecordsSchema.parse(
			this.db
				.query(
					"SELECT owner, collection, key, value FROM records WHERE site=? ORDER BY owner, collection, key"
				)
				.all(site)
		);
		// Imported once into the Site database: a row that does not open fails
		// the import instead of silently dropping visitor data.
		return rows.map((row) => ({
			...row,
			value: this.seal.openText(
				LEGACY_RECORD_VALUE,
				{ site, owner: row.owner, collection: row.collection, key: row.key },
				row.value
			),
		}));
	}
	clearLegacyRecords(site: string): void {
		this.db.query("DELETE FROM records WHERE site=?").run(site);
	}
	delete(id: string) {
		this.db.query("DELETE FROM sites WHERE id=?").run(id);
	}
	close() {
		this.db.close();
	}
}
