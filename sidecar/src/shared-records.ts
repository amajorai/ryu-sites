import { createHash } from "node:crypto";
import { z } from "zod";
import {
	canEdit,
	type RuntimeSite,
	resourceName,
	SHARED_RECORDS_OWNER,
	SITE_LIMITS,
	type SiteDatabaseBinding,
	type SitePrincipal,
} from "./contracts.ts";
import { type SiteDataValue, siteDataValueSchema } from "./data-values.ts";
import { createVisitorRateLimiter } from "./rate-limit.ts";
import type { SitesSpacesDatabase } from "./spaces-database.ts";
import { SiteError } from "./store.ts";

/**
 * Shared multi-visitor records.
 *
 * Every permitted visitor of a Site reads one set of records per collection;
 * writers are signed-in visitors or, when the owner chooses, editors only. A
 * record is changed or removed only by its author, an editor or the owner,
 * and every update names the revision it replaces so concurrent writers never
 * lose each other's changes silently. Records are stored beside per-visitor
 * records under a reserved owner, with the real author kept in an envelope.
 */

/** Record IDs in a shared collection; `events` names the live stream. */
export const sharedRecordId = z
	.string()
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
	.refine((id) => id !== "events", "This record ID is reserved");
export const SHARED_LIST_DEFAULT = 50;
export const SHARED_LIST_MAX = 200;
/** Keepalive interval for live streams, below common proxy idle timeouts. */
export const SHARED_HEARTBEAT_MS = 15_000;
/**
 * A live stream is closed after this long so the visitor's browser reconnects
 * and its identity and access are verified again.
 */
export const SHARED_STREAM_MAX_MS = 30 * 60_000;
/** Recent changes kept per collection for reconnecting subscribers. */
export const SHARED_REPLAY_EVENTS = 200;
/**
 * Replay history kept across every Site and collection in this process. The
 * least recently changed collections are forgotten first; their subscribers
 * receive `reset` and list again.
 */
export const SHARED_REPLAY_BYTES = 8_000_000;
/** Estimated bookkeeping cost of one retained event beyond its JSON. */
const REPLAY_EVENT_OVERHEAD = 128;
/**
 * Unsent bytes one live stream may hold for a subscriber that is not reading.
 * Past it the stream is dropped and the browser reconnects from its last event.
 */
export const SHARED_STREAM_BUFFER_BYTES = 256_000;

const storedEnvelope = z.object({
	author: z.string().min(1),
	createdAt: z.string(),
	updatedAt: z.string(),
	revision: z.number().int().positive(),
	value: siteDataValueSchema,
});
type StoredEnvelope = z.infer<typeof storedEnvelope>;
interface StoredShared extends StoredEnvelope {
	id: string;
}
const setInput = z
	.object({
		value: siteDataValueSchema,
		expectedRevision: z.number().int().nonnegative().optional(),
	})
	.strict();
const createInput = z.object({ value: siteDataValueSchema }).strict();

/** One shared record as a particular viewer sees it. */
export interface SharedRecordView {
	/** Pseudonymous author handle, stable within one Site. */
	author: string;
	/** Whether this viewer may update or delete the record. */
	canModify: boolean;
	createdAt: string;
	id: string;
	/** Whether this viewer wrote the record. */
	mine: boolean;
	revision: number;
	updatedAt: string;
	value: SiteDataValue;
	[key: string]: SiteDataValue;
}

type SharedChange =
	| { type: "set"; collection: string; id: string; record: StoredShared }
	| { type: "delete"; collection: string; id: string };
interface SharedEvent {
	change: SharedChange;
	seq: number;
}
interface ReplayEntry {
	bytes: number;
	/** Newest sequence number no longer replayable for this collection. */
	dropped: number;
	events: { bytes: number; event: SharedEvent }[];
}
interface Subscriber {
	key: string;
	send: (event: SharedEvent) => void;
	site: string;
	visitor: string;
}

/** An author handle other visitors see in place of the account ID. */
export function sharedAuthorHandle(siteId: string, author: string): string {
	return createHash("sha256")
		.update(`${siteId}\n${author}`)
		.digest("hex")
		.slice(0, 16);
}

function viewOf(
	site: RuntimeSite,
	record: StoredShared,
	user: SitePrincipal | null
): SharedRecordView {
	const mine = Boolean(user && user.id === record.author);
	return {
		id: record.id,
		value: record.value,
		author: sharedAuthorHandle(site.id, record.author),
		mine,
		canModify: Boolean(
			user && canWriteShared(site, user) && (mine || canEdit(site, user))
		),
		revision: record.revision,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/** Whether a signed-in visitor may add shared records to this Site. */
export function canWriteShared(
	site: RuntimeSite,
	user: SitePrincipal | null
): boolean {
	if (!user || user.id === SHARED_RECORDS_OWNER) {
		return false;
	}
	return site.settings.sharedData.write === "editors"
		? canEdit(site, user)
		: true;
}

function parseStored(key: string, value: SiteDataValue): StoredShared {
	const parsed = storedEnvelope.safeParse(value);
	if (!parsed.success) {
		throw new SiteError("database_invalid", "A shared record is invalid", 503);
	}
	return { ...parsed.data, id: key };
}

/** Shared records one visitor authored, for the owner's visitor data view. */
export async function sharedRecordsByAuthor(
	database: SitesSpacesDatabase,
	binding: SiteDatabaseBinding
): Promise<
	{ author: string; bytes: number; collection: string; id: string }[]
> {
	const rows = await database.ownerRecords(binding, SHARED_RECORDS_OWNER);
	return rows.map((row) => {
		const stored = parseStored(row.key, row.value);
		return {
			author: stored.author,
			bytes: new TextEncoder().encode(JSON.stringify(row.value)).byteLength,
			collection: row.collection,
			id: row.key,
		};
	});
}

/** Number of shared records a Site holds across its collections. */
export async function sharedRecordCount(
	database: SitesSpacesDatabase,
	binding: SiteDatabaseBinding
): Promise<number> {
	const usage = await database.ownerUsage(binding);
	return (
		usage.find((entry) => entry.owner === SHARED_RECORDS_OWNER)?.records ?? 0
	);
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * Refuses a write that would take the Site past its shared record cap or
 * grow one author's shared records past their share, so a single visitor
 * cannot spend the database budget every visitor's own records rely on.
 * Like the per-visitor share, a write that does not grow usage still passes.
 */
async function assertSharedQuota(
	database: SitesSpacesDatabase,
	binding: SiteDatabaseBinding,
	write: {
		author: string;
		collection: string;
		creating: boolean;
		envelope: StoredEnvelope;
		id: string;
	}
) {
	const rows = await sharedRecordsByAuthor(database, binding);
	if (write.creating && rows.length >= SITE_LIMITS.sharedRecords) {
		throw new SiteError(
			"quota",
			"This Site has reached its shared record limit",
			429
		);
	}
	let records = 0;
	let bytes = 0;
	let replaced = 0;
	for (const row of rows) {
		if (row.author !== write.author) {
			continue;
		}
		records += 1;
		bytes += row.bytes;
		if (row.collection === write.collection && row.id === write.id) {
			replaced = row.bytes;
		}
	}
	const nextRecords = records + (write.creating ? 1 : 0);
	const nextBytes =
		bytes - replaced + byteLength(JSON.stringify(write.envelope));
	if (
		(nextRecords > SITE_LIMITS.sharedRecordsPerAuthor &&
			nextRecords > records) ||
		(nextBytes > SITE_LIMITS.sharedBytesPerAuthor && nextBytes > bytes)
	) {
		throw new SiteError(
			"quota",
			"You have reached your shared record limit for this Site",
			429
		);
	}
}

/**
 * Per-process change feed for shared collections. Event IDs carry a
 * per-process epoch, so a subscriber reconnecting after a restart, or after
 * more changes than the replay window holds, is told to reload instead of
 * silently missing changes.
 */
export function createSharedRecordsHub(
	options: { epoch?: string; replay?: number; replayBytes?: number } = {}
) {
	const epoch = options.epoch ?? crypto.randomUUID().slice(0, 8);
	const replay = options.replay ?? SHARED_REPLAY_EVENTS;
	const replayBytes = options.replayBytes ?? SHARED_REPLAY_BYTES;
	let seq = 0;
	/** Ordered least to most recently changed, for eviction. */
	const history = new Map<string, ReplayEntry>();
	let historyBytes = 0;
	/**
	 * Newest sequence number of any forgotten collection. A cursor older than
	 * it may have missed changes in a collection that is no longer tracked.
	 */
	let evictedThrough = 0;
	const subscribers = new Set<Subscriber>();
	const locks = new Map<string, Promise<void>>();
	const writes = createVisitorRateLimiter({
		visitorLimit: SITE_LIMITS.sharedWritesPerVisitorPerMinute,
		siteLimit: SITE_LIMITS.sharedWritesPerSitePerMinute,
	});
	const keyOf = (site: string, collection: string) => `${site}\n${collection}`;
	const cursor = (value: number) => `${epoch}-${value}`;

	return {
		cursor: () => cursor(seq),
		allowWrite: (site: string, visitor: string) => writes.allow(site, visitor),
		/** Serializes read-modify-write on one Site's shared records. */
		async withLock<T>(site: string, work: () => Promise<T>): Promise<T> {
			const previous = locks.get(site) ?? Promise.resolve();
			let release = () => {};
			const current = new Promise<void>((resolve) => {
				release = resolve;
			});
			locks.set(site, current);
			await previous;
			try {
				return await work();
			} finally {
				release();
				if (locks.get(site) === current) {
					locks.delete(site);
				}
			}
		},
		publish(site: string, change: SharedChange) {
			seq += 1;
			const event = { change, seq };
			const key = keyOf(site, change.collection);
			const entry = history.get(key) ?? {
				bytes: 0,
				dropped: evictedThrough,
				events: [],
			};
			// Re-inserting keeps the map ordered by most recent change.
			history.delete(key);
			history.set(key, entry);
			const bytes = byteLength(JSON.stringify(change)) + REPLAY_EVENT_OVERHEAD;
			entry.events.push({ bytes, event });
			entry.bytes += bytes;
			historyBytes += bytes;
			while (entry.events.length > replay) {
				const oldest = entry.events.shift();
				if (oldest) {
					entry.dropped = oldest.event.seq;
					entry.bytes -= oldest.bytes;
					historyBytes -= oldest.bytes;
				}
			}
			for (const [oldestKey, oldest] of history) {
				if (historyBytes <= replayBytes || oldestKey === key) {
					break;
				}
				history.delete(oldestKey);
				historyBytes -= oldest.bytes;
				evictedThrough = Math.max(
					evictedThrough,
					oldest.events.at(-1)?.event.seq ?? oldest.dropped
				);
			}
			for (const subscriber of subscribers) {
				if (subscriber.key === key) {
					subscriber.send(event);
				}
			}
		},
		/** Bytes of replay history retained across every Site. */
		historyBytes: () => historyBytes,
		/** Clears replay history for a Site whose records were removed. */
		forget(site: string) {
			for (const [key, entry] of history) {
				if (key.startsWith(`${site}\n`)) {
					history.delete(key);
					historyBytes -= entry.bytes;
				}
			}
		},
		/**
		 * Events after `since` for one collection, or null when the subscriber
		 * must reload because those events are no longer known.
		 */
		since(
			site: string,
			collection: string,
			since: string
		): SharedEvent[] | null {
			const match = /^([a-z0-9-]{1,36})-(\d{1,15})$/.exec(since);
			const after = Number(match?.[2]);
			if (!match || match[1] !== epoch || after > seq) {
				return null;
			}
			const entry = history.get(keyOf(site, collection));
			if (!entry) {
				// The collection may have been forgotten after this cursor.
				return after < evictedThrough ? null : [];
			}
			if (after < entry.dropped) {
				return null;
			}
			return entry.events
				.filter(({ event }) => event.seq > after)
				.map(({ event }) => event);
		},
		streams(site: string, visitor?: string) {
			let count = 0;
			for (const subscriber of subscribers) {
				if (
					subscriber.site === site &&
					(visitor === undefined || subscriber.visitor === visitor)
				) {
					count += 1;
				}
			}
			return count;
		},
		subscribe(
			site: string,
			collection: string,
			visitor: string,
			send: (event: SharedEvent) => void
		) {
			const subscriber = {
				key: keyOf(site, collection),
				send,
				site,
				visitor,
			};
			subscribers.add(subscriber);
			return () => {
				subscribers.delete(subscriber);
			};
		},
		eventId: (event: SharedEvent) => cursor(event.seq),
	};
}
export type SharedRecordsHub = ReturnType<typeof createSharedRecordsHub>;

const sse = (fields: { event?: string; id?: string; data: string }) =>
	`${fields.id ? `id: ${fields.id}\n` : ""}${fields.event ? `event: ${fields.event}\n` : ""}data: ${fields.data}\n\n`;

function respond(value: SiteDataValue, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

function conflict(message: string, current: SharedRecordView | null): Response {
	return respond({ error: { code: "conflict", message }, current }, 409);
}

export interface SharedRecordsRequest {
	/**
	 * Re-reads the Site and confirms this visitor may still read its shared
	 * data. A live stream closes as soon as it returns false.
	 */
	authorized: () => boolean;
	database: SitesSpacesDatabase | undefined;
	hub: SharedRecordsHub;
	/** Lifts the listener idle timeout for one long-lived stream. */
	keepOpen: () => void;
	readBody: (limit: number) => Promise<SiteDataValue>;
	request: Request;
	site: RuntimeSite;
	url: URL;
	user: SitePrincipal | null;
	/** Rate and stream key: the account ID, or the address when signed out. */
	visitor: string;
}

/**
 * Serves `/_ryu/shared/:collection[/:id|/events]` on the visitor listener.
 * Returns null for any other path. The caller has already confirmed the
 * visitor may open the Site and that a mutation comes from its own origin.
 */
export async function handleSharedRecords(
	input: SharedRecordsRequest
): Promise<Response | null> {
	const route = /^\/_ryu\/shared\/([^/]+)(?:\/([^/]+))?$/.exec(
		input.url.pathname
	);
	if (!route) {
		return null;
	}
	const { site, user, request, hub } = input;
	if (!site.settings.sharedData.enabled) {
		throw new SiteError(
			"disabled",
			"Shared data is disabled for this Site",
			403
		);
	}
	if (site.settings.mode !== "connected") {
		throw new SiteError("disabled", "This Site uses browser-local data", 403);
	}
	const binding = site.settings.database;
	const database = input.database;
	if (!(binding && database)) {
		throw new SiteError(
			"unavailable",
			"The Site's shared data is unavailable",
			503
		);
	}
	if (user?.id === SHARED_RECORDS_OWNER) {
		throw new SiteError(
			"forbidden",
			"This account cannot use shared data",
			403
		);
	}
	const collection = resourceName.parse(route[1]);
	const segment = route[2];
	if (segment === "events") {
		if (request.method !== "GET") {
			throw new SiteError("method", "Method not allowed", 405);
		}
		return stream(input, collection);
	}
	const id = segment === undefined ? null : sharedRecordId.parse(segment);
	const read = async (recordId: string) => {
		const rows = await database.records(
			binding,
			SHARED_RECORDS_OWNER,
			collection,
			recordId
		);
		const row = rows[0];
		return row ? parseStored(row.key, row.value) : null;
	};

	if (request.method === "GET") {
		if (id) {
			const record = await read(id);
			if (!record) {
				throw new SiteError("not_found", "Shared record not found", 404);
			}
			return respond(viewOf(site, record, user));
		}
		const limit = z.coerce
			.number()
			.int()
			.min(1)
			.max(SHARED_LIST_MAX)
			.default(SHARED_LIST_DEFAULT)
			.parse(input.url.searchParams.get("limit") ?? undefined);
		const after = input.url.searchParams.get("cursor");
		if (after !== null) {
			sharedRecordId.parse(after);
		}
		// The event cursor is read before the records, so a subscriber that
		// starts from it never misses a change made after this list.
		const eventCursor = hub.cursor();
		const rows = (
			await database.records(binding, SHARED_RECORDS_OWNER, collection, null)
		)
			.map((row) => parseStored(row.key, row.value))
			.filter((record) => after === null || record.id > after)
			.sort((left, right) => (left.id < right.id ? -1 : 1));
		const page = rows.slice(0, limit);
		return respond({
			records: page.map((record) => viewOf(site, record, user)),
			nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
			eventCursor,
		});
	}

	if (!user) {
		throw new SiteError("unauthorized", "Sign in to change shared data", 401);
	}
	if (!canWriteShared(site, user)) {
		throw new SiteError(
			"forbidden",
			"Only this Site's editors can change its shared data",
			403
		);
	}
	const mayModify = (record: StoredShared) =>
		record.author === user.id || canEdit(site, user);

	if (request.method === "DELETE" && id) {
		const expected = input.url.searchParams.get("expectedRevision");
		const expectedRevision =
			expected === null
				? null
				: z.coerce.number().int().positive().parse(expected);
		if (!hub.allowWrite(site.id, user.id)) {
			throw new SiteError(
				"rate_limit",
				"Too many shared data changes; retry shortly",
				429
			);
		}
		return hub.withLock(site.id, async () => {
			const existing = await read(id);
			if (!existing) {
				throw new SiteError("not_found", "Shared record not found", 404);
			}
			if (!mayModify(existing)) {
				throw new SiteError(
					"forbidden",
					"Only the author, an editor or the owner can delete this record",
					403
				);
			}
			if (expectedRevision !== null && expectedRevision !== existing.revision) {
				return conflict(
					"This record changed since you read it",
					viewOf(site, existing, user)
				);
			}
			await database.deleteRecord(
				binding,
				SHARED_RECORDS_OWNER,
				collection,
				id
			);
			hub.publish(site.id, { type: "delete", collection, id });
			return respond({ deleted: true, id });
		});
	}

	if ((request.method === "PUT" && id) || (request.method === "POST" && !id)) {
		const raw = await input.readBody(SITE_LIMITS.sharedRecordBytes + 1000);
		const parsed =
			request.method === "POST"
				? { ...createInput.parse(raw), expectedRevision: 0 }
				: setInput.parse(raw);
		const encoded = JSON.stringify(parsed.value);
		if (encoded === undefined) {
			throw new SiteError("invalid_input", "A shared record needs a value");
		}
		if (byteLength(encoded) > SITE_LIMITS.sharedRecordBytes) {
			throw new SiteError(
				"too_large",
				`A shared record value must be at most ${SITE_LIMITS.sharedRecordBytes} bytes`,
				413
			);
		}
		if (!hub.allowWrite(site.id, user.id)) {
			throw new SiteError(
				"rate_limit",
				"Too many shared data changes; retry shortly",
				429
			);
		}
		const recordId = id ?? crypto.randomUUID();
		return hub.withLock(site.id, async () => {
			const existing = await read(recordId);
			const now = new Date().toISOString();
			let next: StoredShared;
			if (existing) {
				if (!mayModify(existing)) {
					throw new SiteError(
						"forbidden",
						"Only the author, an editor or the owner can change this record",
						403
					);
				}
				if (parsed.expectedRevision !== existing.revision) {
					return conflict(
						parsed.expectedRevision === undefined
							? "This record already exists; send the revision you are replacing"
							: "This record changed since you read it",
						viewOf(site, existing, user)
					);
				}
				next = {
					...existing,
					value: parsed.value,
					revision: existing.revision + 1,
					updatedAt: now,
				};
			} else {
				if (
					parsed.expectedRevision !== undefined &&
					parsed.expectedRevision !== 0
				) {
					return conflict("This record was deleted since you read it", null);
				}
				next = {
					id: recordId,
					author: user.id,
					createdAt: now,
					updatedAt: now,
					revision: 1,
					value: parsed.value,
				};
			}
			const envelope: StoredEnvelope = {
				author: next.author,
				createdAt: next.createdAt,
				updatedAt: next.updatedAt,
				revision: next.revision,
				value: next.value,
			};
			await assertSharedQuota(database, binding, {
				author: next.author,
				collection,
				creating: !existing,
				envelope,
				id: recordId,
			});
			await database.saveRecord(binding, {
				owner: SHARED_RECORDS_OWNER,
				collection,
				key: recordId,
				value: JSON.stringify(envelope),
			});
			hub.publish(site.id, {
				type: "set",
				collection,
				id: recordId,
				record: next,
			});
			return respond(viewOf(site, next, user), existing ? 200 : 201);
		});
	}
	throw new SiteError("method", "Method not allowed", 405);
}

function stream(input: SharedRecordsRequest, collection: string): Response {
	const { hub, site, user, request } = input;
	if (
		hub.streams(site.id) >= SITE_LIMITS.sharedStreamsPerSite ||
		hub.streams(site.id, input.visitor) >= SITE_LIMITS.sharedStreamsPerVisitor
	) {
		throw new SiteError(
			"rate_limit",
			"Too many live connections to this Site; retry shortly",
			429
		);
	}
	const since =
		request.headers.get("last-event-id") ?? input.url.searchParams.get("since");
	input.keepOpen();
	const format = (event: SharedEvent) =>
		sse({
			event: "change",
			id: hub.eventId(event),
			data: JSON.stringify(
				event.change.type === "set"
					? {
							type: "set",
							collection,
							id: event.change.id,
							record: viewOf(site, event.change.record, user),
						}
					: { type: "delete", collection, id: event.change.id }
			),
		});
	const encoder = new TextEncoder();
	let close = (_overflow?: boolean) => {};
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let closed = false;
				const write = (text: string) => {
					if (closed) {
						return;
					}
					controller.enqueue(encoder.encode(text));
					// A subscriber that stops reading must not make the sidecar hold
					// every later change; drop it and let the browser reconnect.
					if ((controller.desiredSize ?? 1) <= 0) {
						close(true);
					}
				};
				const unsubscribe = hub.subscribe(
					site.id,
					collection,
					input.visitor,
					(event) => {
						if (!input.authorized()) {
							close();
							return;
						}
						write(format(event));
					}
				);
				const heartbeat = setInterval(() => {
					if (input.authorized()) {
						write(": keepalive\n\n");
					} else {
						close();
					}
				}, SHARED_HEARTBEAT_MS);
				const lifetime = setTimeout(() => close(), SHARED_STREAM_MAX_MS);
				const onAbort = () => close();
				close = (overflow = false) => {
					if (closed) {
						return;
					}
					closed = true;
					unsubscribe();
					clearInterval(heartbeat);
					clearTimeout(lifetime);
					request.signal.removeEventListener("abort", onAbort);
					try {
						if (overflow) {
							// Erroring discards the unsent queue instead of keeping it
							// until a stalled connection drains.
							controller.error(
								new SiteError(
									"slow_subscriber",
									"The live stream fell behind; reconnect to resume",
									503
								)
							);
						} else {
							controller.close();
						}
					} catch {
						/* The client already went away. */
					}
				};
				request.signal.addEventListener("abort", onAbort);
				write("retry: 3000\n\n");
				const known =
					since === null ? [] : hub.since(site.id, collection, since);
				const missed = known?.map(format) ?? null;
				if (
					missed === null ||
					missed.reduce((total, text) => total + byteLength(text), 0) >
						SHARED_STREAM_BUFFER_BYTES / 2
				) {
					// The changes since the visitor's cursor are no longer known; the
					// page must list the collection again before trusting new events.
					write(
						sse({
							event: "reset",
							id: hub.cursor(),
							data: JSON.stringify({ collection }),
						})
					);
					return;
				}
				for (const text of missed) {
					write(text);
				}
				write(
					sse({
						event: "ready",
						id: missed.length ? undefined : hub.cursor(),
						data: JSON.stringify({ collection }),
					})
				);
			},
			cancel() {
				close();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: SHARED_STREAM_BUFFER_BYTES })
	);
	return new Response(body, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		},
	});
}
