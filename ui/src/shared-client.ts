import type { SiteDataValue } from "../../sidecar/src/data-values.ts";

/**
 * Visitor SDK for shared multi-visitor records: `RyuSite.shared(collection)`.
 * Every permitted visitor reads the same records; changes arrive live over
 * Server-Sent Events. Updates name the revision they replace, so a write
 * that would overwrite someone else's change fails with a 409 instead.
 */
export type SharedRequest = (
	path: string,
	method?: string,
	body?: SiteDataValue
) => Promise<SiteDataValue>;

/** What a subscriber is told: a change, a ready stream, or a reload hint. */
export type SharedEvent =
	| { type: "set"; collection: string; id: string; record: SiteDataValue }
	| { type: "delete"; collection: string; id: string }
	| { type: "ready"; collection: string }
	| { type: "reset"; collection: string }
	| { type: "error"; collection: string; closed: boolean };

interface EventSourceLike {
	addEventListener(
		type: string,
		listener: (event: { data?: string }) => void
	): void;
	close(): void;
	onerror: ((event: Event) => void) | null;
	readyState: number;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

const COLLECTION = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const EVENT_SOURCE_CLOSED = 2;

function recordId(value: string): string {
	if (!RECORD_ID.test(value) || value === "events") {
		throw new Error("Invalid shared record ID");
	}
	return value;
}

function parseData(data: string | undefined): SiteDataValue {
	try {
		return JSON.parse(data ?? "null");
	} catch {
		return null;
	}
}

export function createSharedCollection(
	collection: string,
	request: SharedRequest,
	eventSource: EventSourceFactory
) {
	if (!COLLECTION.test(collection)) {
		throw new Error("Invalid resource name");
	}
	const base = `shared/${collection}`;
	return {
		/** One page of records ordered by ID; pass `nextCursor` for the next. */
		list(options: { limit?: number; cursor?: string | null } = {}) {
			const query = new URLSearchParams();
			if (options.limit !== undefined) {
				query.set("limit", String(options.limit));
			}
			if (options.cursor) {
				query.set("cursor", recordId(options.cursor));
			}
			const search = query.toString();
			return request(search ? `${base}?${search}` : base);
		},
		get(id: string) {
			return request(`${base}/${recordId(id)}`);
		},
		/**
		 * Creates a record (`id` null for a server-chosen ID) or replaces one.
		 * Replacing an existing record needs the `expectedRevision` you read.
		 */
		set(
			id: string | null,
			value: SiteDataValue,
			options: { expectedRevision?: number } = {}
		) {
			if (id === null) {
				return request(base, "POST", { value });
			}
			return request(`${base}/${recordId(id)}`, "PUT", {
				value,
				expectedRevision: options.expectedRevision,
			});
		},
		delete(id: string, options: { expectedRevision?: number } = {}) {
			const suffix =
				options.expectedRevision === undefined
					? ""
					: `?expectedRevision=${encodeURIComponent(String(options.expectedRevision))}`;
			return request(`${base}/${recordId(id)}${suffix}`, "DELETE");
		},
		/**
		 * Receives live changes. Pass the `eventCursor` from `list()` as `since`
		 * so nothing between the list and the subscription is missed. The
		 * browser reconnects with Last-Event-ID; a `reset` event means changes
		 * were missed and the page should list the collection again.
		 */
		subscribe(
			callback: (event: SharedEvent) => void,
			options: { since?: string } = {}
		): () => void {
			const since = options.since
				? `?since=${encodeURIComponent(options.since)}`
				: "";
			const source = eventSource(`/_ryu/${base}/events${since}`);
			source.addEventListener("change", (event) => {
				const data = parseData(event.data);
				if (data && typeof data === "object" && !Array.isArray(data)) {
					const id = typeof data.id === "string" ? data.id : "";
					if (data.type === "delete") {
						callback({ type: "delete", collection, id });
					} else if (data.type === "set") {
						callback({ type: "set", collection, id, record: data.record });
					}
				}
			});
			source.addEventListener("ready", () =>
				callback({ type: "ready", collection })
			);
			source.addEventListener("reset", () =>
				callback({ type: "reset", collection })
			);
			source.onerror = () =>
				callback({
					type: "error",
					collection,
					closed: source.readyState === EVENT_SOURCE_CLOSED,
				});
			return () => source.close();
		},
	};
}
