import {
	createSidecarHostClient,
	SidecarHostError,
} from "@ryu/sidecar-runtime";
import { z } from "zod";
import {
	SHARED_RECORDS_OWNER,
	SITE_LIMITS,
	type SiteDatabaseBinding,
} from "./contracts.ts";
import {
	type SiteDataRecord,
	type SiteDataValue,
	siteDataRecordSchema,
	siteDataValueSchema,
} from "./data-values.ts";
import { SiteError } from "./store.ts";

const databaseDocument = z.object({
	id: z.string(),
	kind: z.literal("database"),
	revision: z.number().int().nonnegative(),
	space_id: z.string(),
	source: z.string(),
	title: z.string(),
});
const databaseSummary = z.object({
	id: z.string(),
	title: z.string(),
	updated_at: z.number(),
});
const queryResult = z.object({
	columns: z.array(z.string()),
	rows: z.array(z.array(siteDataValueSchema)),
	schema: z.array(
		z.object({ id: z.string(), label: z.string(), name: z.string() })
	),
	truncated: z.boolean(),
});
const databaseColumn = z
	.object({
		cell: siteDataValueSchema,
		id: z.string(),
		label: z.string(),
	})
	.passthrough();
const databaseRow = siteDataRecordSchema;
const databaseGrid = z
	.object({
		columns: z.array(databaseColumn),
		rows: z.array(databaseRow),
	})
	.passthrough();

const SITE_DATABASE_TITLE = "Site data";
const DATABASE_SPACE_PREFIX = "Ryu Sites · ";

export interface LegacySiteRecord {
	collection: string;
	key: string;
	owner: string;
	value: string;
}

export type SiteDatabaseQueryResult = z.infer<typeof queryResult>;

/** One visitor's saved records, as the owner's visitor data view counts them. */
export interface SiteOwnerUsage {
	bytes: number;
	owner: string;
	records: number;
}

export interface SitesSpacesDatabase {
	count(binding: SiteDatabaseBinding): Promise<number>;
	deleteDatabase(binding: SiteDatabaseBinding): Promise<void>;
	/** Deletes every record one visitor saved; returns how many were removed. */
	deleteOwnerRecords(
		binding: SiteDatabaseBinding,
		owner: string
	): Promise<number>;
	deleteRecord(
		binding: SiteDatabaseBinding,
		owner: string,
		collection: string,
		key: string
	): Promise<boolean>;
	ensureForSite(input: {
		id: string;
		name: string;
	}): Promise<SiteDatabaseBinding>;
	importRecords(
		binding: SiteDatabaseBinding,
		records: LegacySiteRecord[]
	): Promise<void>;
	/** Every record one owner holds, across collections, ordered by key. */
	ownerRecords(
		binding: SiteDatabaseBinding,
		owner: string
	): Promise<{ collection: string; key: string; value: SiteDataValue }[]>;
	/** Record count and stored bytes for each visitor with saved records. */
	ownerUsage(binding: SiteDatabaseBinding): Promise<SiteOwnerUsage[]>;
	query(
		binding: SiteDatabaseBinding,
		statement: string,
		parameters?: SiteDataValue[]
	): Promise<SiteDatabaseQueryResult>;
	records(
		binding: SiteDatabaseBinding,
		owner: string,
		collection: string,
		key: string | null
	): Promise<{ key: string; value: SiteDataValue }[]>;
	saveRecord(
		binding: SiteDatabaseBinding,
		input: LegacySiteRecord
	): Promise<void>;
}

function emptySiteDatabaseSource(): string {
	return JSON.stringify({
		columns: [
			{ id: "owner", label: "Owner", cell: { variant: "short-text" } },
			{
				id: "collection",
				label: "Collection",
				cell: { variant: "short-text" },
			},
			{ id: "key", label: "Key", cell: { variant: "short-text" } },
			{ id: "value", label: "Value", cell: { variant: "long-text" } },
		],
		rows: [],
		views: [{ id: "view_table", name: "Table", kind: "table" }],
	});
}

function parseGrid(source: string) {
	if (source.trim() === "") {
		return databaseGrid.parse(JSON.parse(emptySiteDatabaseSource()));
	}
	let parsed: SiteDataValue;
	try {
		parsed = siteDataValueSchema.parse(JSON.parse(source));
	} catch {
		throw new SiteError(
			"database_invalid",
			"The Ryu Spaces database is invalid",
			503
		);
	}
	const result = databaseGrid.safeParse(parsed);
	if (!result.success) {
		throw new SiteError(
			"database_invalid",
			"The Ryu Spaces database schema is invalid",
			503
		);
	}
	return result.data;
}

function siteColumns(grid: z.infer<typeof databaseGrid>) {
	const columns = new Map(grid.columns.map((column) => [column.id, column]));
	const owner = columns.get("owner");
	const collection = columns.get("collection");
	const key = columns.get("key");
	const value = columns.get("value");
	if (!(owner && collection && key && value)) {
		throw new SiteError(
			"database_schema",
			"The Ryu Spaces database must keep its Owner, Collection, Key, and Value fields",
			409
		);
	}
	return { owner, collection, key, value };
}

function sqlIdentifier(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
		throw new SiteError(
			"database_schema",
			"The Ryu Spaces database has an invalid SQL column",
			503
		);
	}
	return `"${name}"`;
}

function updateRow(
	grid: z.infer<typeof databaseGrid>,
	input: LegacySiteRecord
): void {
	const columns = siteColumns(grid);
	const existingIndex = grid.rows.findIndex(
		(row) =>
			row[columns.owner.id] === input.owner &&
			row[columns.collection.id] === input.collection &&
			row[columns.key.id] === input.key
	);
	const existing = existingIndex >= 0 ? grid.rows[existingIndex] : null;
	const next = {
		...existing,
		[columns.owner.id]: input.owner,
		[columns.collection.id]: input.collection,
		[columns.key.id]: input.key,
		[columns.value.id]: input.value,
		__id: z.string().safeParse(existing?.__id).success
			? z.string().parse(existing?.__id)
			: `row_${crypto.randomUUID()}`,
	} satisfies SiteDataRecord;
	if (existingIndex >= 0) {
		grid.rows[existingIndex] = next;
	} else {
		grid.rows.push(next);
	}
}

function rowBytes(row: SiteDataRecord): number {
	return new TextEncoder().encode(JSON.stringify(row)).byteLength;
}

function ownerUsage(grid: z.infer<typeof databaseGrid>, owner: string) {
	const columns = siteColumns(grid);
	let records = 0;
	let bytes = 0;
	for (const row of grid.rows) {
		if (row[columns.owner.id] === owner) {
			records += 1;
			bytes += rowBytes(row);
		}
	}
	return { records, bytes };
}

/** Groups rows by visitor with the same byte measure as the per-visitor share. */
function ownersUsage(grid: z.infer<typeof databaseGrid>): SiteOwnerUsage[] {
	const columns = siteColumns(grid);
	const usage = new Map<string, SiteOwnerUsage>();
	for (const row of grid.rows) {
		const owner = z.string().safeParse(row[columns.owner.id]);
		if (!owner.success) {
			continue;
		}
		const current = usage.get(owner.data) ?? {
			owner: owner.data,
			records: 0,
			bytes: 0,
		};
		current.records += 1;
		current.bytes += rowBytes(row);
		usage.set(owner.data, current);
	}
	return [...usage.values()];
}

/**
 * Refuses a save that grows one visitor's rows past their share of the Site.
 * Shared records have their own Site-wide cap, enforced by the shared route.
 */
export function assertOwnerShare(
	before: { records: number; bytes: number },
	after: { records: number; bytes: number },
	owner?: string
) {
	if (owner === SHARED_RECORDS_OWNER) {
		return;
	}
	const overRecords =
		after.records > SITE_LIMITS.recordsPerVisitor &&
		after.records > before.records;
	const overBytes =
		after.bytes > SITE_LIMITS.recordBytesPerVisitor &&
		after.bytes > before.bytes;
	if (overRecords || overBytes) {
		throw new SiteError(
			"quota",
			"You have reached your saved record limit for this Site",
			429
		);
	}
}

export function createSitesSpacesDatabase(options: {
	corePort: number;
	token: string;
	userJwt?: string;
	fetchImpl?: typeof fetch;
}): SitesSpacesDatabase {
	const host = createSidecarHostClient({
		corePort: options.corePort,
		token: options.token,
		pluginId: "@ryu/sites",
		fetchImpl: options.fetchImpl,
	});
	const locks = new Map<string, Promise<void>>();

	async function withLock<T>(
		databaseId: string,
		work: () => Promise<T>
	): Promise<T> {
		const previous = locks.get(databaseId) ?? Promise.resolve();
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		locks.set(databaseId, current);
		await previous;
		try {
			return await work();
		} finally {
			release();
			if (locks.get(databaseId) === current) {
				locks.delete(databaseId);
			}
		}
	}

	async function getDocument(binding: SiteDatabaseBinding) {
		const raw = await host.call(
			"spaces.getDatabase",
			{ space_id: binding.spaceId, database_id: binding.databaseId },
			options.userJwt
		);
		const document = databaseDocument.parse(raw);
		if (
			document.space_id !== binding.spaceId ||
			document.id !== binding.databaseId
		) {
			throw new SiteError(
				"database_invalid",
				"Ryu Spaces returned a different database",
				503
			);
		}
		return document;
	}

	async function query(
		binding: SiteDatabaseBinding,
		statement: string,
		parameters: SiteDataValue[] = []
	) {
		return queryResult.parse(
			await host.call(
				"spaces.queryDatabase",
				{
					database_id: binding.databaseId,
					parameters: z.json().parse(JSON.parse(JSON.stringify(parameters))),
					query: statement,
					space_id: binding.spaceId,
				},
				options.userJwt
			)
		);
	}

	async function mutate(
		binding: SiteDatabaseBinding,
		change: (grid: z.infer<typeof databaseGrid>) => void
	) {
		return withLock(binding.databaseId, async () => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const document = await getDocument(binding);
				const grid = parseGrid(document.source);
				change(grid);
				const source = JSON.stringify(grid);
				if (
					new TextEncoder().encode(source).byteLength >
					SITE_LIMITS.databaseBytes
				) {
					throw new SiteError(
						"quota",
						"The Site's Ryu Spaces database has reached its storage limit",
						413
					);
				}
				try {
					await host.call(
						"spaces.updateDatabase",
						{
							database_id: binding.databaseId,
							expected_revision: document.revision,
							source,
							space_id: binding.spaceId,
							title: document.title,
						},
						options.userJwt
					);
					return;
				} catch (error) {
					if (error instanceof SidecarHostError && error.status === 409) {
						continue;
					}
					throw error;
				}
			}
			throw new SiteError(
				"database_conflict",
				"The Ryu Spaces database changed repeatedly. Retry the request.",
				409
			);
		});
	}

	async function ensureForSite(input: {
		id: string;
		name: string;
	}): Promise<SiteDatabaseBinding> {
		const spaceId = z
			.string()
			.min(1)
			.parse(
				await host.call(
					"spaces.ensureSpace",
					{
						name: `${DATABASE_SPACE_PREFIX}${input.id}`,
						description: `Private visitor data for ${input.name}`,
					},
					options.userJwt
				)
			);
		const summaries = z
			.array(databaseSummary)
			.parse(
				await host.call(
					"spaces.listDatabases",
					{ space_id: spaceId },
					options.userJwt
				)
			);
		const existing = summaries.find(
			(database) => database.title === SITE_DATABASE_TITLE
		);
		const databaseId =
			existing?.id ??
			z
				.string()
				.min(1)
				.parse(
					await host.call(
						"spaces.createDatabase",
						{ space_id: spaceId, title: SITE_DATABASE_TITLE },
						options.userJwt
					)
				);
		const binding = { spaceId, databaseId };
		const document = await getDocument(binding);
		if (document.source.trim() === "") {
			await mutate(binding, (grid) => {
				grid.columns = databaseGrid.parse(
					JSON.parse(emptySiteDatabaseSource())
				).columns;
			});
		}
		return binding;
	}

	return {
		ensureForSite,
		async query(
			binding: SiteDatabaseBinding,
			statement: string,
			parameters?: SiteDataValue[]
		) {
			return query(binding, statement, parameters);
		},
		async records(
			binding: SiteDatabaseBinding,
			owner: string,
			collection: string,
			key: string | null
		) {
			const schema = await query(binding, "SELECT * FROM data LIMIT 0");
			const column = (id: string) => {
				const found = schema.schema.find((entry) => entry.id === id);
				if (!found) {
					throw new SiteError(
						"database_schema",
						"Site data columns are unavailable",
						503
					);
				}
				return sqlIdentifier(found.name);
			};
			const ownerColumn = column("owner");
			const collectionColumn = column("collection");
			const keyColumn = column("key");
			const valueColumn = column("value");
			const result = await query(
				binding,
				`SELECT ${keyColumn} AS key, ${valueColumn} AS value FROM data WHERE ${ownerColumn} = ? AND ${collectionColumn} = ? AND (? IS NULL OR ${keyColumn} = ?) LIMIT 1000`,
				[owner, collection, key, key]
			);
			const keyIndex = result.columns.indexOf("key");
			const valueIndex = result.columns.indexOf("value");
			if (keyIndex < 0 || valueIndex < 0) {
				throw new SiteError(
					"database_schema",
					"Site data columns are unavailable",
					503
				);
			}
			return result.rows.map((row) => {
				const recordKey = row[keyIndex];
				const encodedValue = row[valueIndex];
				if (
					!(
						z.string().safeParse(recordKey).success &&
						z.string().safeParse(encodedValue).success
					)
				) {
					throw new SiteError(
						"database_invalid",
						"A Site record is invalid",
						503
					);
				}
				try {
					const value = siteDataValueSchema.parse(
						JSON.parse(z.string().parse(encodedValue))
					);
					return { key: z.string().parse(recordKey), value };
				} catch {
					throw new SiteError(
						"database_invalid",
						"A Site record is invalid",
						503
					);
				}
			});
		},
		async saveRecord(binding: SiteDatabaseBinding, input: LegacySiteRecord) {
			await mutate(binding, (grid) => {
				const before = ownerUsage(grid, input.owner);
				updateRow(grid, input);
				assertOwnerShare(before, ownerUsage(grid, input.owner), input.owner);
			});
		},
		async deleteRecord(
			binding: SiteDatabaseBinding,
			owner: string,
			collection: string,
			key: string
		) {
			let deleted = false;
			await mutate(binding, (grid) => {
				const columns = siteColumns(grid);
				const rows = grid.rows.filter((row) => {
					const matches =
						row[columns.owner.id] === owner &&
						row[columns.collection.id] === collection &&
						row[columns.key.id] === key;
					deleted ||= matches;
					return !matches;
				});
				grid.rows = rows;
			});
			return deleted;
		},
		async ownerUsage(binding: SiteDatabaseBinding) {
			return ownersUsage(parseGrid((await getDocument(binding)).source));
		},
		async ownerRecords(binding: SiteDatabaseBinding, owner: string) {
			const grid = parseGrid((await getDocument(binding)).source);
			const columns = siteColumns(grid);
			const found: {
				collection: string;
				key: string;
				value: SiteDataValue;
			}[] = [];
			for (const row of grid.rows) {
				if (row[columns.owner.id] !== owner) {
					continue;
				}
				const collection = z.string().safeParse(row[columns.collection.id]);
				const key = z.string().safeParse(row[columns.key.id]);
				const encoded = z.string().safeParse(row[columns.value.id]);
				if (!(collection.success && key.success && encoded.success)) {
					throw new SiteError(
						"database_invalid",
						"A Site record is invalid",
						503
					);
				}
				let value: SiteDataValue;
				try {
					value = siteDataValueSchema.parse(JSON.parse(encoded.data));
				} catch {
					throw new SiteError(
						"database_invalid",
						"A Site record is invalid",
						503
					);
				}
				found.push({ collection: collection.data, key: key.data, value });
			}
			return found.sort(
				(left, right) =>
					left.collection.localeCompare(right.collection) ||
					left.key.localeCompare(right.key)
			);
		},
		async deleteOwnerRecords(binding: SiteDatabaseBinding, owner: string) {
			let deleted = 0;
			await mutate(binding, (grid) => {
				const columns = siteColumns(grid);
				const kept = grid.rows.filter((row) => row[columns.owner.id] !== owner);
				deleted = grid.rows.length - kept.length;
				grid.rows = kept;
			});
			return deleted;
		},
		async count(binding: SiteDatabaseBinding) {
			const result = await query(binding, "SELECT COUNT(*) AS total FROM data");
			const count = result.rows[0]?.[0];
			if (
				!(
					z.number().int().nonnegative().safeParse(count).success &&
					Number.isSafeInteger(count)
				)
			) {
				throw new SiteError(
					"database_invalid",
					"Ryu Spaces returned an invalid row count",
					503
				);
			}
			return z.number().parse(count);
		},
		async importRecords(
			binding: SiteDatabaseBinding,
			records: LegacySiteRecord[]
		) {
			if (records.length === 0) {
				return;
			}
			await mutate(binding, (grid) => {
				for (const record of records) {
					updateRow(grid, record);
				}
			});
		},
		async deleteDatabase(binding: SiteDatabaseBinding) {
			await host.call(
				"spaces.deleteDatabase",
				{ database_id: binding.databaseId, space_id: binding.spaceId },
				options.userJwt
			);
		},
	};
}
