import { createHash } from "node:crypto";
import { z } from "zod";
import { type RuntimeSite, SHARED_RECORDS_OWNER } from "./contracts.ts";
import type { SiteDataRecord } from "./data-values.ts";
import { sharedRecordsByAuthor } from "./shared-records.ts";
import type { SitesSpacesDatabase } from "./spaces-database.ts";
import { SiteError, type SitesStore } from "./store.ts";

/** Longest visitor account ID a purge accepts; identity subjects are far shorter. */
const MAX_OWNER_LENGTH = 512;
/** Purge entries returned with the visitor list. */
export const VISITOR_AUDIT_ENTRIES = 20;
/** Purge entries kept per Site; older entries are dropped as new ones arrive. */
export const VISITOR_AUDIT_RETAINED = 1000;
export const VISITOR_DATA_DELETE_ACTION = "visitor_data.delete";
const VISITOR_KEY = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARACTER = /\p{Cc}/u;

const fileUsageRow = z.object({
	owner: z.string(),
	files: z.number(),
	bytes: z.number(),
});
const recordUsageRow = z.object({
	owner: z.string(),
	records: z.number(),
	bytes: z.number(),
});
const fileTotalsRow = z.object({ files: z.number(), bytes: z.number() });
const auditDetail = z.object({
	files: z.number(),
	fileBytes: z.number(),
	records: z.number(),
});
const auditRow = z.object({
	at: z.string(),
	actor: z.string(),
	action: z.literal(VISITOR_DATA_DELETE_ACTION),
	subject: z.string(),
	detail: z.string(),
});

/** One visitor's stored data in a Site, as the owner's visitor data view shows it. */
export interface VisitorDataSummary extends SiteDataRecord {
	fileBytes: number;
	files: number;
	/** The visitor's verified account ID. */
	owner: string;
	recordBytes: number;
	/** Records counts and bytes include the shared records this visitor wrote. */
	records: number;
	/** Shared multi-visitor records this visitor authored. */
	sharedRecords: number;
	/** URL-safe key that names this visitor in the delete route. */
	visitor: string;
}

/** An audited purge. `visitor` is a digest of the account ID, never the ID. */
export interface VisitorDataAudit extends SiteDataRecord {
	action: typeof VISITOR_DATA_DELETE_ACTION;
	actor: string;
	at: string;
	fileBytes: number;
	files: number;
	records: number;
	visitor: string;
}

interface VisitorDataContext {
	database: SitesSpacesDatabase | undefined;
	databaseLabel: string;
	site: RuntimeSite;
	store: SitesStore;
}

/** Encodes a visitor account ID as one path segment Core and Sites both pass unchanged. */
export function visitorKey(owner: string): string {
	return Buffer.from(owner, "utf8").toString("base64url");
}

/** Decodes a visitor key; only the canonical encoding of a plain ID is accepted. */
export function visitorOwner(key: string): string {
	const invalid = () =>
		new SiteError("invalid_input", "Choose a visitor from the list", 400);
	if (key.length > MAX_OWNER_LENGTH * 2 || !VISITOR_KEY.test(key)) {
		throw invalid();
	}
	const owner = Buffer.from(key, "base64url").toString("utf8");
	if (
		owner.length === 0 ||
		owner.length > MAX_OWNER_LENGTH ||
		CONTROL_CHARACTER.test(owner) ||
		visitorKey(owner) !== key
	) {
		throw invalid();
	}
	return owner;
}

function visitorDigest(owner: string): string {
	return createHash("sha256").update(owner).digest("hex").slice(0, 16);
}

function unavailable(context: VisitorDataContext, verb: string): SiteError {
	return new SiteError(
		"unavailable",
		`Access to ${context.databaseLabel} is unavailable, so visitor records could not be ${verb}`,
		503
	);
}

/**
 * Lists every visitor with saved records or uploaded files in one Site, with
 * their counts and stored bytes, plus the Site's most recent purges.
 */
export async function listVisitorData(context: VisitorDataContext): Promise<{
	audit: VisitorDataAudit[];
	visitors: VisitorDataSummary[];
}> {
	const { site, store } = context;
	const binding = site.settings.database;
	if (binding && !context.database) {
		throw unavailable(context, "read");
	}
	const databaseUsage =
		binding && context.database
			? (await context.database.ownerUsage(binding)).filter(
					(usage) => usage.owner !== SHARED_RECORDS_OWNER
				)
			: [];
	const sharedUsage =
		binding && context.database
			? await sharedRecordsByAuthor(context.database, binding)
			: [];
	const legacyUsage = recordUsageRow
		.array()
		.parse(
			store.db
				.query(
					"SELECT owner, COUNT(*) AS records, COALESCE(SUM(COALESCE(size, LENGTH(value))),0) AS bytes FROM records WHERE site=? AND owner IS NOT NULL GROUP BY owner"
				)
				.all(site.id)
		);
	const fileUsage = fileUsageRow
		.array()
		.parse(
			store.db
				.query(
					"SELECT owner, COUNT(*) AS files, COALESCE(SUM(COALESCE(size, LENGTH(data))),0) AS bytes FROM files WHERE site=? AND owner IS NOT NULL GROUP BY owner"
				)
				.all(site.id)
		);
	const visitors = new Map<string, VisitorDataSummary>();
	const entry = (owner: string) => {
		const current = visitors.get(owner) ?? {
			visitor: visitorKey(owner),
			owner,
			files: 0,
			fileBytes: 0,
			records: 0,
			recordBytes: 0,
			sharedRecords: 0,
		};
		visitors.set(owner, current);
		return current;
	};
	for (const usage of [...databaseUsage, ...legacyUsage]) {
		const current = entry(usage.owner);
		current.records += usage.records;
		current.recordBytes += usage.bytes;
	}
	for (const usage of sharedUsage) {
		const current = entry(usage.author);
		current.records += 1;
		current.sharedRecords += 1;
		current.recordBytes += usage.bytes;
	}
	for (const usage of fileUsage) {
		const current = entry(usage.owner);
		current.files += usage.files;
		current.fileBytes += usage.bytes;
	}
	const audit = auditRow
		.array()
		.parse(
			store.db
				.query(
					"SELECT at, actor, action, subject, detail FROM site_audit WHERE site=? AND action=? ORDER BY rowid DESC LIMIT ?"
				)
				.all(site.id, VISITOR_DATA_DELETE_ACTION, VISITOR_AUDIT_ENTRIES)
		)
		.map((row) => ({
			action: row.action,
			actor: row.actor,
			at: row.at,
			visitor: row.subject,
			...auditDetail.parse(JSON.parse(row.detail)),
		}));
	return {
		visitors: [...visitors.values()].sort(
			(left, right) =>
				right.fileBytes +
					right.recordBytes -
					(left.fileBytes + left.recordBytes) ||
				left.owner.localeCompare(right.owner)
		),
		audit,
	};
}

/**
 * Deletes one visitor's records and uploaded files from a Site and audits the
 * purge. Records are removed first: when the records database cannot be
 * reached, nothing is deleted and nothing is audited.
 */
export async function purgeVisitorData(
	context: VisitorDataContext & {
		actor: string;
		owner: string;
		/** Announces each removed shared record to live subscribers. */
		sharedDeleted?: (collection: string, id: string) => void;
	}
): Promise<VisitorDataAudit> {
	const { site, store, owner } = context;
	if (owner === SHARED_RECORDS_OWNER) {
		throw new SiteError("invalid_input", "Choose a visitor from the list", 400);
	}
	const binding = site.settings.database;
	if (binding && !context.database) {
		throw unavailable(context, "deleted");
	}
	let databaseRecords = 0;
	if (binding && context.database) {
		// Shared records the visitor wrote go with their personal records; the
		// visitor's contributions are theirs to have removed.
		const authored = (
			await sharedRecordsByAuthor(context.database, binding)
		).filter((record) => record.author === owner);
		for (const record of authored) {
			if (
				await context.database.deleteRecord(
					binding,
					SHARED_RECORDS_OWNER,
					record.collection,
					record.id
				)
			) {
				databaseRecords += 1;
				context.sharedDeleted?.(record.collection, record.id);
			}
		}
		databaseRecords += await context.database.deleteOwnerRecords(
			binding,
			owner
		);
	}
	return store.db.transaction(() => {
		const files = fileTotalsRow.parse(
			store.db
				.query(
					"SELECT COUNT(*) AS files, COALESCE(SUM(COALESCE(size, LENGTH(data))),0) AS bytes FROM files WHERE site=? AND owner=?"
				)
				.get(site.id, owner)
		);
		store.db
			.query("DELETE FROM files WHERE site=? AND owner=?")
			.run(site.id, owner);
		const legacyRecords = store.db
			.query("DELETE FROM records WHERE site=? AND owner=?")
			.run(site.id, owner).changes;
		const audit: VisitorDataAudit = {
			action: VISITOR_DATA_DELETE_ACTION,
			actor: context.actor,
			at: new Date().toISOString(),
			visitor: visitorDigest(owner),
			files: files.files,
			fileBytes: files.bytes,
			records: databaseRecords + legacyRecords,
		};
		store.db.query("INSERT INTO site_audit VALUES(?,?,?,?,?,?)").run(
			site.id,
			audit.at,
			audit.actor,
			audit.action,
			audit.visitor,
			JSON.stringify({
				files: audit.files,
				fileBytes: audit.fileBytes,
				records: audit.records,
			})
		);
		store.db
			.query(
				"DELETE FROM site_audit WHERE site=? AND action=? AND rowid NOT IN (SELECT rowid FROM site_audit WHERE site=? AND action=? ORDER BY rowid DESC LIMIT ?)"
			)
			.run(
				site.id,
				VISITOR_DATA_DELETE_ACTION,
				site.id,
				VISITOR_DATA_DELETE_ACTION,
				VISITOR_AUDIT_RETAINED
			);
		return audit;
	})();
}
