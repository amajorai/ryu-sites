import type { Database } from "bun:sqlite";
import type { StoreSeal } from "@ryu/sidecar-runtime/content-seal";
import { z } from "zod";
import { SITE_LIMITS, type SiteDatabaseBinding } from "./contracts.ts";
import { type SiteDataValue, siteDataValueSchema } from "./data-values.ts";
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
/** Wall-clock budget for one SQL console query, including the helper's start. */
export const LOCAL_QUERY_TIMEOUT_MS = 3000;
const MAX_QUERY_BYTES = 8000;
const MAX_PARAMETERS = 64;
const MAX_CONCURRENT_QUERIES = 2;
const MAX_HELPER_OUTPUT_BYTES = 4_000_000;
const QUERY_SCHEMA = [
	{ id: "owner", label: "Owner", name: "owner" },
	{ id: "collection", label: "Collection", name: "collection" },
	{ id: "key", label: "Key", name: "key" },
	{ id: "value", label: "Value", name: "value" },
];

/**
 * Runs in a short-lived helper process so a runaway query can be killed. Bun's
 * SQLite binding cannot interrupt a statement, and a thread cannot be stopped
 * mid-statement. The helper sees only the Site's own rows on stdin, keeps temp
 * storage in memory (a sort never spills decrypted rows to disk), caps the
 * SQLite heap, locks the copy read-only and bounds the result like Ryu Spaces.
 */
const QUERY_HELPER = `const { Database } = require("bun:sqlite");
const write = (value) => process.stdout.write(JSON.stringify(value));
try {
	const input = JSON.parse(await Bun.stdin.text());
	const db = new Database(":memory:");
	// Bun's SQLite defaults temp storage to files: a large sort would spill the
	// decrypted rows to an unlinked temp file. Keep it in the capped heap.
	db.exec("PRAGMA temp_store=MEMORY");
	db.exec('CREATE TABLE data ("owner", "collection", "key", "value")');
	const insert = db.prepare("INSERT INTO data VALUES (?, ?, ?, ?)");
	db.transaction(() => { for (const row of input.rows) insert.run(row[0], row[1], row[2], row[3]); })();
	db.exec("PRAGMA hard_heap_limit=67108864");
	db.exec("PRAGMA query_only=ON");
	const statement = db.prepare(input.statement);
	const columns = statement.columnNames;
	// Bun 1.3 de-duplicates columnNames (SELECT 1 AS a, 2 AS a gives ["a"]), so the
	// real column count comes from declaredTypes, which has one entry per column.
	// Bun 1.4 keeps every name but refuses declaredTypes before the first step.
	let columnCount = columns.length;
	try { columnCount = statement.declaredTypes.length; } catch {}
	if (columnCount > 128) throw new Error("query returns too many columns");
	if (columnCount !== columns.length || new Set(columns).size !== columns.length) throw new Error("give each result column a distinct name with AS");
	const rows = [];
	let bytes = 0;
	let truncated = false;
	for (const record of statement.iterate(...input.parameters)) {
		if (rows.length >= 500) { truncated = true; break; }
		// A lower bound on the row's JSON size, checked before converting a BLOB
		// into an array, so one huge value is refused without burning the budget.
		let floor = 0;
		for (const name of columns) {
			const value = record[name];
			floor += value instanceof Uint8Array ? value.byteLength * 2 : typeof value === "string" ? value.length : 0;
		}
		if (bytes + floor > 1048576) { truncated = true; break; }
		const row = columns.map((name) => {
			const value = record[name];
			if (value instanceof Uint8Array) return Array.from(value);
			if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
			return value ?? null;
		});
		const size = JSON.stringify(row).length;
		if (bytes + size > 1048576) { truncated = true; break; }
		bytes += size;
		rows.push(row);
	}
	write({ ok: true, columns, rows, truncated });
} catch (error) {
	write({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
}`;

const helperResult = z.union([
	z.object({
		ok: z.literal(true),
		columns: z.array(z.string()),
		rows: z.array(z.array(siteDataValueSchema)),
		truncated: z.boolean(),
	}),
	z.object({ ok: z.literal(false), error: z.string() }),
]);
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

function startsWithSelect(query: string): boolean {
	let rest = query.trimStart();
	while (true) {
		if (rest.startsWith("--")) {
			const end = rest.indexOf("\n");
			rest = end < 0 ? "" : rest.slice(end + 1).trimStart();
			continue;
		}
		if (rest.startsWith("/*")) {
			const end = rest.indexOf("*/");
			if (end < 0) {
				return false;
			}
			rest = rest.slice(end + 2).trimStart();
			continue;
		}
		break;
	}
	const keyword = /^[A-Za-z]*/.exec(rest)?.[0]?.toLowerCase() ?? "";
	return keyword === "select" || keyword === "with";
}

type QuoteState =
	| "none"
	| "single"
	| "double"
	| "backtick"
	| "bracket"
	| "line"
	| "block";

const OPENERS = new Map<string, QuoteState>([
	["'", "single"],
	['"', "double"],
	["`", "backtick"],
	["[", "bracket"],
]);

/** Counts statements outside quotes and comments, like Ryu Spaces. */
function hasMultipleStatements(query: string): boolean {
	let state: QuoteState = "none";
	let statements = 0;
	let content = false;
	for (let index = 0; index < query.length; index += 1) {
		const char = query[index] ?? "";
		const next = query[index + 1];
		if (state === "none") {
			if (char === "-" && next === "-") {
				state = "line";
				index += 1;
			} else if (char === "/" && next === "*") {
				state = "block";
				index += 1;
			} else if (OPENERS.has(char)) {
				state = OPENERS.get(char) ?? "none";
				content = true;
			} else if (char === ";") {
				if (content) {
					statements += 1;
					content = false;
				}
			} else if (!/\s/.test(char)) {
				content = true;
			}
			continue;
		}
		const closesDoubled =
			(state === "single" && char === "'") ||
			(state === "double" && char === '"');
		if (closesDoubled) {
			if (next === char) {
				index += 1;
			} else {
				state = "none";
			}
		} else if (
			(state === "backtick" && char === "`") ||
			(state === "bracket" && char === "]") ||
			(state === "line" && char === "\n")
		) {
			state = "none";
		} else if (state === "block" && char === "*" && next === "/") {
			state = "none";
			index += 1;
		}
	}
	return statements + (content ? 1 : 0) > 1;
}

function sqlParameter(value: SiteDataValue): string | number | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "boolean") {
		return value ? 1 : 0;
	}
	if (typeof value === "number" || typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}

async function readLimited(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	onOverflow: () => void
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		size += chunk.value.byteLength;
		if (size > limit) {
			onOverflow();
			await reader.cancel();
			throw new SiteError(
				"invalid_input",
				"The query result exceeds the size limit",
				400
			);
		}
		chunks.push(chunk.value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
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
		const bytes = new TextEncoder().encode(statement).byteLength;
		if (bytes > MAX_QUERY_BYTES || statement.trim() === "") {
			throw new SiteError(
				"invalid_input",
				`A query must contain 1 to ${MAX_QUERY_BYTES} bytes`
			);
		}
		if (parameters.length > MAX_PARAMETERS) {
			throw new SiteError(
				"invalid_input",
				`A query supports at most ${MAX_PARAMETERS} parameters`
			);
		}
		if (!startsWithSelect(statement) || hasMultipleStatements(statement)) {
			throw new SiteError(
				"invalid_input",
				"Only one read-only SELECT query is allowed"
			);
		}
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
			const helper = Bun.spawn([process.execPath, "-e", QUERY_HELPER], {
				cwd: options.workDir,
				// A minimal environment: the helper needs no secrets, and inherited
				// BUN_* or NODE_* options must not change how it starts.
				env: { BUN_BE_BUN: "1" },
				stdin: new Blob([
					JSON.stringify({
						rows,
						statement,
						parameters: parameters.map(sqlParameter),
					}),
				]),
				stdout: "pipe",
				stderr: "ignore",
			});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				helper.kill(9);
			}, timeoutMs);
			let output: string;
			try {
				output = await readLimited(helper.stdout, MAX_HELPER_OUTPUT_BYTES, () =>
					helper.kill(9)
				);
				await helper.exited;
			} finally {
				clearTimeout(timer);
			}
			if (timedOut) {
				throw new SiteError(
					"query_timeout",
					"The query took too long and was stopped",
					400
				);
			}
			let parsed: z.infer<typeof helperResult>;
			try {
				parsed = helperResult.parse(JSON.parse(output));
			} catch {
				throw new SiteError(
					"query_failed",
					"The query could not be completed",
					400
				);
			}
			if (!parsed.ok) {
				throw new SiteError(
					"invalid_input",
					`The SQL query failed: ${parsed.error}`
				);
			}
			return {
				columns: parsed.columns,
				rows: parsed.rows,
				schema: QUERY_SCHEMA,
				truncated: parsed.truncated,
			};
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
