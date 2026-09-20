import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	createSiteInput,
	type RuntimeSite,
	SITE_LIMITS,
	type SitePrincipal,
	siteSettings,
} from "./contracts.ts";

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
	constructor(path: string) {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
		PRAGMA user_version=1;`);
	}
	list(): RuntimeSite[] {
		return (
			this.db.query("SELECT state FROM sites ORDER BY rowid DESC").all() as {
				state: string;
			}[]
		).map((row) => JSON.parse(row.state) as RuntimeSite);
	}
	get(id: string): RuntimeSite {
		const row = this.db.query("SELECT state FROM sites WHERE id=?").get(id) as {
			state: string;
		} | null;
		if (!row) {
			throw new SiteError("not_found", "Site not found", 404);
		}
		const site = JSON.parse(row.state) as RuntimeSite;
		site.settings = siteSettings.parse(site.settings);
		return site;
	}
	create(input: unknown, owner: SitePrincipal): RuntimeSite {
		const parsed = createSiteInput.parse(input);
		if (this.list().length >= SITE_LIMITS.projects) {
			throw new SiteError("quota", "Project limit reached", 429);
		}
		this.assertSlugAvailable(parsed.slug);
		const now = new Date().toISOString();
		const site: RuntimeSite = {
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
		};
		this.db
			.query("INSERT INTO sites VALUES(?,?,?)")
			.run(site.id, site.slug, JSON.stringify(site));
		return site;
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
				.run(site.slug, JSON.stringify(site), id);
			return site;
		})();
	}
	artifact(site: string, version: string): string {
		const row = this.db
			.query("SELECT html FROM artifacts WHERE site=? AND id=?")
			.get(site, version) as { html: string } | null;
		if (!row) {
			throw new SiteError("not_found", "Saved version not found", 404);
		}
		return row.html;
	}
	delete(id: string) {
		this.db.query("DELETE FROM sites WHERE id=?").run(id);
	}
	close() {
		this.db.close();
	}
}
