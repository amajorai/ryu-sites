import { describe, expect, test } from "bun:test";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
import {
	createSharedCollection,
	type EventSourceFactory,
	type SharedEvent,
} from "./shared-client.ts";

function recorder() {
	const calls: { path: string; method?: string; body?: SiteDataValue }[] = [];
	const request = (path: string, method?: string, body?: SiteDataValue) => {
		calls.push({ path, method, body });
		return Promise.resolve(null);
	};
	return { calls, request };
}

function fakeEventSource() {
	const listeners = new Map<string, (event: { data?: string }) => void>();
	const opened: string[] = [];
	let closed = false;
	const source = {
		readyState: 1,
		onerror: null as ((event: Event) => void) | null,
		addEventListener(
			type: string,
			listener: (event: { data?: string }) => void
		) {
			listeners.set(type, listener);
		},
		close() {
			closed = true;
		},
	};
	const factory: EventSourceFactory = (url) => {
		opened.push(url);
		return source;
	};
	return {
		factory,
		opened,
		source,
		emit: (type: string, data?: string) => listeners.get(type)?.({ data }),
		isClosed: () => closed,
	};
}

describe("RyuSite.shared visitor SDK", () => {
	test("maps list, get, set and delete to the shared routes", async () => {
		const { calls, request } = recorder();
		const board = createSharedCollection(
			"board",
			request,
			fakeEventSource().factory
		);
		await board.list();
		await board.list({ limit: 20, cursor: "abc" });
		await board.get("note-1");
		await board.set(null, { text: "new" });
		await board.set("note-1", { text: "edit" }, { expectedRevision: 3 });
		await board.delete("note-1", { expectedRevision: 4 });
		expect(calls).toEqual([
			{ path: "shared/board", method: undefined, body: undefined },
			{
				path: "shared/board?limit=20&cursor=abc",
				method: undefined,
				body: undefined,
			},
			{ path: "shared/board/note-1", method: undefined, body: undefined },
			{
				path: "shared/board",
				method: "POST",
				body: { value: { text: "new" } },
			},
			{
				path: "shared/board/note-1",
				method: "PUT",
				body: { value: { text: "edit" }, expectedRevision: 3 },
			},
			{
				path: "shared/board/note-1?expectedRevision=4",
				method: "DELETE",
				body: undefined,
			},
		]);
	});

	test("refuses invalid collection names and reserved record IDs", () => {
		const { request } = recorder();
		const { factory } = fakeEventSource();
		expect(() => createSharedCollection("../x", request, factory)).toThrow();
		const board = createSharedCollection("board", request, factory);
		expect(() => board.get("events")).toThrow();
		expect(() => board.get("a/b")).toThrow();
	});

	test("subscribe delivers parsed changes and unsubscribes", () => {
		const { request } = recorder();
		const events = fakeEventSource();
		const board = createSharedCollection("board", request, events.factory);
		const received: SharedEvent[] = [];
		const unsubscribe = board.subscribe((event) => received.push(event), {
			since: "abc-4",
		});
		expect(events.opened).toEqual(["/_ryu/shared/board/events?since=abc-4"]);
		events.emit("ready");
		events.emit(
			"change",
			JSON.stringify({
				type: "set",
				collection: "board",
				id: "n1",
				record: { id: "n1", value: 1 },
			})
		);
		events.emit(
			"change",
			JSON.stringify({ type: "delete", collection: "board", id: "n1" })
		);
		events.emit("change", "not json");
		events.emit("reset");
		events.source.readyState = 2;
		events.source.onerror?.(new Event("error"));
		expect(received).toEqual([
			{ type: "ready", collection: "board" },
			{
				type: "set",
				collection: "board",
				id: "n1",
				record: { id: "n1", value: 1 },
			},
			{ type: "delete", collection: "board", id: "n1" },
			{ type: "reset", collection: "board" },
			{ type: "error", collection: "board", closed: true },
		]);
		unsubscribe();
		expect(events.isClosed()).toBe(true);
	});
});
