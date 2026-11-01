import type { Database } from "bun:sqlite";
import type { StoreSeal } from "@ryu/sidecar-runtime/content-seal";
import { z } from "zod";
import { SITE_LIMITS, type SiteDatabaseBinding } from "./contracts.ts";
import { type SiteDataValue, siteDataValueSchema } from "./data-values.ts";
import {
	assertConsoleQuery,
	LOCAL_QUERY_TIMEOUT_MS,
	runQueryHelper,
} from "./local-query.ts";
import {
	assertOwnerShare,
	type LegacySiteRecord,
	type SiteDatabaseQueryResult,
	type SitesSpacesDatabase,
} from "./spaces-database.ts";
import {
	DATABASE_RECORD_VALUE,
	SITE_DATABASE_RECORDS_DDL,
	SiteError,
} from "./store.ts";

/** The `spaceId` of a binding whose records live in this process's SQLite file. */
export const LOCAL_DATABASE_SPACE_ID = "local";
const MAX_CONCURRENT_QUERIES = 2;
const recordRow = z.object({ key: z.string(), value: z.string() });
const ownerRecordRow = recordRow.extend({ collection: z.string() });
const usageRow = z.object({ records: z.number(), bytes: z.number() });
const bytesRow = z.object({ bytes: z.number() });
const countRow = z.object({ count: z.number() });
const ownerUsageRow = z.object({
	owner: z.string(),
	records: z.number(),
	bytes: z.number(),
});
const projectionRow = z.object({
	owner: z.string(),
	collection: z.string(),
	key: z.string(),
	value: z.string(),
});

/** Mirrors the row size Ryu Spaces counts, so both backends share one budget. */
function rowBytes(input: LegacySiteRecord): number {
	return new TextEncoder().encode(
		JSON.stringify({
			owner: input.owner,
			collection: input.collection,
			key: input.key,
			value: input.value,
		})
	).byteLength;
}

/**
 * Standalone durable visitor records: the `SitesSpacesDatabase` contract kept in
 * this process's SQLite file instead of a Ryu Spaces database, with the same
 * Site, per-visitor and storage limits. Rows are deleted with their Site.
 */
export function createLocalSitesDatabase(options: {
	db: Database;
	/** Operator-owned working directory for the SQL console helper process. */
	workDir: string;
	queryTimeoutMs?: number;
	/**
	 * The store's sealer (`SitesStore.seal`): record values are sealed at rest
	 * and opened here. Omitted (tests) keeps plaintext values.
	 */
	seal?: StoreSeal;
}): SitesSpacesDatabase {
	const { db, seal } = options;
	const timeoutMs = options.queryTimeoutMs ?? LOCAL_QUERY_TIMEOUT_MS;
	db.exec(SITE_DATABASE_RECORDS_DDL);
	type RecordIds = Record<"collection" | "key" | "owner" | "site", string>;
	const sealValue = (ids: RecordIds, value: string): string =>
		seal ? seal.sealText(DATABASE_RECORD_VALUE, ids, value) : value;
	const openValue = (ids: RecordIds, value: string): string =>
		seal ? seal.openText(DATABASE_RECORD_VALUE, ids, value) : value;
	/** For whole-site projections: a row that does not open is counted and skipped. */
	const tryOpenValue = (ids: RecordIds, value: string): string | null =>
		seal ? seal.tryOpenText(DATABASE_RECORD_VALUE, ids, value) : value;
	let runningQueries = 0;

	const siteOf = (binding: SiteDatabaseBinding): string => {
		if (binding.spaceId !== LOCAL_DATABASE_SPACE_ID) {
			throw new SiteError(
				"unavailable",
				"This Site's records are in a Ryu Spaces database, which this Sites service cannot reach",
				503
			);
		}
		return binding.databaseId;
	};
	const siteBytes = (site: string) =>
		bytesRow.parse(
			db
				.query(
					"SELECT COALESCE(SUM(bytes),0) AS bytes FROM site_database_records WHERE site=?"
				)
				.get(site)
		).bytes;
	const assertStorage = (site: string) => {
		if (siteBytes(site) > SITE_LIMITS.databaseBytes) {
			throw new SiteError(
				"quota",
				"The Site's database has reached its storage limit",
				413
			);
		}
	};
	const upsert = db.query(
		"INSERT INTO site_database_records VALUES(?,?,?,?,?,?) ON CONFLICT(site,owner,collection,key) DO UPDATE SET value=excluded.value, bytes=excluded.bytes"
	);

	async function runQuery(
		site: string,
		statement: string,
		parameters: SiteDataValue[]
	): Promise<SiteDatabaseQueryResult> {
		assertConsoleQuery(statement, parameters);
		if (runningQueries >= MAX_CONCURRENT_QUERIES) {
			throw new SiteError(
				"busy",
				"Another database query is running; retry shortly",
				429
			);
		}
		runningQueries += 1;
		try {
			const rows = projectionRow
				.array()
				.parse(
					db
						.query(
							"SELECT owner, collection, key, value FROM site_database_records WHERE site=? ORDER BY rowid"
						)
						.all(site)
				)
				.flatMap((row) => {
					// The helper gets opened values over stdin only (never a file).
					const value = tryOpenValue({ site, ...row }, row.value);
					return value === null
						? []
						: [[row.owner, row.collection, row.key, value]];
				});
			return await runQueryHelper({
				rows,
				statement,
				parameters,
				workDir: options.workDir,
				timeoutMs,
			});
		} finally {
			runningQueries -= 1;
		}
	}

	return {
		ensureForSite: async ({ id }) => ({
			spaceId: LOCAL_DATABASE_SPACE_ID,
			databaseId: id,
		}),
		query: async (binding, statement, parameters = []) =>
			runQuery(siteOf(binding), statement, parameters),
		records: async (binding, owner, collection, key) => {
			const site = siteOf(binding);
			const rows = recordRow
				.array()
				.parse(
					db
						.query(
							"SELECT key, value FROM site_database_records WHERE site=? AND owner=? AND collection=? AND (?4 IS NULL OR key=?4) ORDER BY key LIMIT 1000"
						)
						.all(site, owner, collection, key)
				);
			return rows.map((row) => {
				try {
					const value = openValue(
						{ site, owner, collection, key: row.key },
						row.value
					);
					return {
						key: row.key,
						value: siteDataValueSchema.parse(JSON.parse(value)),
					};
				} catch {
					throw new SiteError(
						"database_invalid",
						"A Site record is invalid",
						503
					);
				}
			});
		},
		saveRecord: async (binding, input) => {
			const site = siteOf(binding);
			db.transaction(() => {
				const before = usageRow.parse(
					db
						.query(
							"SELECT COUNT(*) AS records, COALESCE(SUM(bytes),0) AS bytes FROM site_database_records WHERE site=? AND owner=?"
						)
						.get(site, input.owner)
				);
				const existing = z
					.object({ bytes: z.number() })
					.nullable()
					.parse(
						db
							.query(
								"SELECT bytes FROM site_database_records WHERE site=? AND owner=? AND collection=? AND key=?"
							)
							.get(site, input.owner, input.collection, input.key)
					);
				const bytes = rowBytes(input);
				assertOwnerShare(
					before,
					{
						records: before.records + (existing ? 0 : 1),
						bytes: before.bytes - (existing?.bytes ?? 0) + bytes,
					},
					input.owner
				);
				upsert.run(
					site,
					input.owner,
					input.collection,
					input.key,
					sealValue({ site, ...input }, input.value),
					bytes
				);
				assertStorage(site);
			})();
		},
		deleteRecord: async (binding, owner, collection, key) =>
			db
				.query(
					"DELETE FROM site_database_records WHERE site=? AND owner=? AND collection=? AND key=?"
				)
				.run(siteOf(binding), owner, collection, key).changes > 0,
		ownerUsage: async (binding) =>
			ownerUsageRow
				.array()
				.parse(
					db
						.query(
							"SELECT owner, COUNT(*) AS records, COALESCE(SUM(bytes),0) AS bytes FROM site_database_records WHERE site=? GROUP BY owner ORDER BY owner"
						)
						.all(siteOf(binding))
				),
		ownerRecords: async (binding, owner) => {
			const site = siteOf(binding);
			return ownerRecordRow
				.array()
				.parse(
					db
						.query(
							"SELECT collection, key, value FROM site_database_records WHERE site=? AND owner=? ORDER BY collection, key"
						)
						.all(site, owner)
				)
				.map((row) => {
					try {
						const value = openValue(
							{ site, owner, collection: row.collection, key: row.key },
							row.value
						);
						return {
							collection: row.collection,
							key: row.key,
							value: siteDataValueSchema.parse(JSON.parse(value)),
						};
					} catch {
						throw new SiteError(
							"database_invalid",
							"A Site record is invalid",
							503
						);
					}
				});
		},
		deleteOwnerRecords: async (binding, owner) =>
			db
				.query("DELETE FROM site_database_records WHERE site=? AND owner=?")
				.run(siteOf(binding), owner).changes,
		count: async (binding) =>
			countRow.parse(
				db
					.query(
						"SELECT COUNT(*) AS count FROM site_database_records WHERE site=?"
					)
					.get(siteOf(binding))
			).count,
		importRecords: async (binding, records) => {
			const site = siteOf(binding);
			db.transaction(() => {
				for (const record of records) {
					upsert.run(
						site,
						record.owner,
						record.collection,
						record.key,
						sealValue({ site, ...record }, record.value),
						rowBytes(record)
					);
				}
				assertStorage(site);
			})();
		},
		deleteDatabase: async (binding) => {
			db.query("DELETE FROM site_database_records WHERE site=?").run(
				siteOf(binding)
			);
		},
	};
}
