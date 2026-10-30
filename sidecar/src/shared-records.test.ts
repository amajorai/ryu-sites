import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type RuntimeSite,
	SHARED_RECORDS_OWNER,
	SITE_LIMITS,
	type SitePrincipal,
} from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createLocalSitesDatabase } from "./local-database.ts";
import { createSitesServer } from "./server.ts";
import {
	createSharedRecordsHub,
	handleSharedRecords,
	SHARED_STREAM_BUFFER_BYTES,
} from "./shared-records.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";
import { visitorKey } from "./visitor-data-admin.ts";

const TOKEN = "shared-records-test-token";
const workDir = mkdtempSync(join(tmpdir(), "ryu-sites-shared-"));
const cleanup: (() => void)[] = [];
afterAll(() => {
	for (const close of cleanup.splice(0)) {
		close();
	}
	rmSync(workDir, { recursive: true, force: true });
});

const ownerPrincipal: SitePrincipal = {
	id: "node-owner",
	email: "owner@example.com",
	workspaceIds: ["ws"],
};
const principals: Record<string, SitePrincipal> = {
	owner: ownerPrincipal,
	editor: { id: "editor", email: "editor@example.com", workspaceIds: ["ws"] },
	alice: { id: "alice", email: "alice@example.com", workspaceIds: [] },
	bob: { id: "bob", email: "bob@example.com", workspaceIds: [] },
	reserved: {
		id: SHARED_RECORDS_OWNER,
		email: "reserved@example.com",
		workspaceIds: [],
	},
};
type Who = keyof typeof principals | null;

const sharedView = z.object({
	id: z.string(),
	value: z.unknown(),
	author: z.string(),
	mine: z.boolean(),
	canModify: z.boolean(),
	revision: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
const listResponse = z.object({
	records: z.array(sharedView),
	nextCursor: z.string().nullable(),
	eventCursor: z.string(),
});

function harness() {
	const store = new SitesStore(":memory:");
	const database = createLocalSitesDatabase({ db: store.db, workDir });
	const server = createSitesServer({
		store,
		token: TOKEN,
		port: 0,
		visitorPort: 0,
		publicEnabled: true,
		services: {
			identity: async (request) => {
				const name = request.headers.get("authorization")?.slice(7) ?? "";
				return principals[name] ?? null;
			},
			managementIdentity: async () => ownerPrincipal,
			scanArtifact: async () => ({ allowed: true, reason: null }),
			spacesDatabase: database,
		},
	});
	cleanup.push(() => {
		server.stop();
		store.close();
	});
	const admin = async (path: string, method = "GET", body?: SiteDataValue) =>
		fetch(`http://127.0.0.1:${server.admin.port}/api/sites${path}`, {
			method,
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const visit = (
		slug: string,
		who: Who,
		path: string,
		method = "GET",
		body?: SiteDataValue,
		extra: Record<string, string> = {}
	) =>
		fetch(`http://127.0.0.1:${server.visitor.port}${path}`, {
			method,
			headers: {
				host: `${slug}.localhost:${server.visitor.port}`,
				origin: `http://${slug}.localhost:${server.visitor.port}`,
				"content-type": "application/json",
				...(who ? { authorization: `Bearer ${who}` } : {}),
				...extra,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const ok = async (response: Response, status = 200) => {
		if (response.status !== status) {
			throw new Error(`${response.status}: ${await response.text()}`);
		}
		return response;
	};
	/** A deployed, public, connected Site with a bound database. */
	const site = async (
		slug: string,
		sharedData: RuntimeSite["settings"]["sharedData"] = {
			enabled: true,
			write: "signed-in",
		},
		audience: RuntimeSite["settings"]["audience"] = "public"
	) => {
		let current = runtimeSiteSchema.parse(
			await (
				await ok(
					await admin("/projects", "POST", { name: "Shared", slug }),
					201
				)
			).json()
		);
		current = runtimeSiteSchema.parse(
			await (
				await ok(
					await admin(`/projects/${current.id}/versions`, "POST", {
						html: starterHtml("Shared", "website", ""),
						expectedRevision: current.revision,
					}),
					201
				)
			).json()
		);
		current = runtimeSiteSchema.parse(
			await (
				await ok(
					await admin(`/projects/${current.id}/deploy`, "POST", {
						versionId: current.versions.at(-1)?.id ?? "",
						expectedRevision: current.revision,
					})
				)
			).json()
		);
		current = runtimeSiteSchema.parse(
			await (
				await ok(
					await admin(`/projects/${current.id}/database/connect`, "POST", {
						expectedRevision: current.revision,
					})
				)
			).json()
		);
		return runtimeSiteSchema.parse(
			await (
				await ok(
					await admin(`/projects/${current.id}/settings`, "PUT", {
						settings: {
							...current.settings,
							audience,
							mode: "connected",
							workspaceId: "ws",
							editors: ["editor@example.com"],
							sharedData,
						},
						expectedRevision: current.revision,
					})
				)
			).json()
		);
	};
	return { store, database, server, admin, visit, site };
}

/** A stored shared-record envelope, as the database keeps it. */
function envelope(author: string, value: SiteDataValue) {
	return JSON.stringify({
		author,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		revision: 1,
		value,
	});
}

const largeChange = (id: string) => ({
	type: "set" as const,
	collection: "board",
	id,
	record: {
		id,
		author: "alice",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		revision: 1,
		value: "x".repeat(SITE_LIMITS.sharedRecordBytes - 100),
	},
});

describe("shared multi-visitor records", () => {
	test("are off by default and need a connected database to enable", async () => {
		const h = harness();
		const off = await h.site("shared-off", {
			enabled: false,
			write: "signed-in",
		});
		expect(off.settings.sharedData).toEqual({
			enabled: false,
			write: "signed-in",
		});
		const denied = await h.visit(off.slug, "alice", "/_ryu/shared/board");
		expect(denied.status).toBe(403);
		expect(
			(await (await h.visit(off.slug, "alice", "/_ryu/config")).json())
				.sharedData
		).toBe(false);
		const created = runtimeSiteSchema.parse(
			await (
				await h.admin("/projects", "POST", {
					name: "No database",
					slug: "shared-nodb",
				})
			).json()
		);
		const refused = await h.admin(`/projects/${created.id}/settings`, "PUT", {
			settings: {
				...created.settings,
				mode: "connected",
				sharedData: { enabled: true, write: "signed-in" },
			},
			expectedRevision: created.revision,
		});
		expect(refused.status).toBe(400);
		expect((await refused.json()).error.code).toBe("database_required");
		const local = await h.admin(`/projects/${off.id}/settings`, "PUT", {
			settings: {
				...off.settings,
				mode: "local",
				sharedData: { enabled: true, write: "signed-in" },
			},
			expectedRevision: off.revision,
		});
		expect(local.status).toBe(400);
	});

	test("enforce the read/write/modify authorization matrix", async () => {
		const h = harness();
		const site = await h.site("shared-authz");
		const config = await (
			await h.visit(site.slug, null, "/_ryu/config")
		).json();
		expect(config.sharedData).toBe(true);
		expect(config.sharedWrite).toBe("signed-in");
		// Anyone who may visit reads; only signed-in visitors write.
		expect((await h.visit(site.slug, null, "/_ryu/shared/board")).status).toBe(
			200
		);
		expect(
			(
				await h.visit(site.slug, null, "/_ryu/shared/board", "POST", {
					value: { text: "anon" },
				})
			).status
		).toBe(401);
		const created = await h.visit(
			site.slug,
			"alice",
			"/_ryu/shared/board",
			"POST",
			{ value: { text: "hello" } }
		);
		expect(created.status).toBe(201);
		const record = sharedView.parse(await created.json());
		expect(record).toMatchObject({ mine: true, canModify: true, revision: 1 });
		expect(record.author).not.toContain("alice");
		// Cross-origin mutations never reach the handler.
		expect(
			(
				await h.visit(
					site.slug,
					"alice",
					"/_ryu/shared/board",
					"POST",
					{ value: 1 },
					{ origin: "https://evil.example" }
				)
			).status
		).toBe(403);
		// Other visitors read it but cannot change or delete it.
		const seenByBob = sharedView.parse(
			await (
				await h.visit(site.slug, "bob", `/_ryu/shared/board/${record.id}`)
			).json()
		);
		expect(seenByBob).toMatchObject({ mine: false, canModify: false });
		expect(seenByBob.author).toBe(record.author);
		expect(
			(
				await h.visit(
					site.slug,
					"bob",
					`/_ryu/shared/board/${record.id}`,
					"PUT",
					{ value: { text: "hijack" }, expectedRevision: 1 }
				)
			).status
		).toBe(403);
		expect(
			(
				await h.visit(
					site.slug,
					"bob",
					`/_ryu/shared/board/${record.id}`,
					"DELETE"
				)
			).status
		).toBe(403);
		// Editors and the owner moderate any record.
		const edited = await h.visit(
			site.slug,
			"editor",
			`/_ryu/shared/board/${record.id}`,
			"PUT",
			{ value: { text: "edited" }, expectedRevision: 1 }
		);
		expect(edited.status).toBe(200);
		expect(sharedView.parse(await edited.json()).revision).toBe(2);
		expect(
			(
				await h.visit(
					site.slug,
					"owner",
					`/_ryu/shared/board/${record.id}`,
					"DELETE"
				)
			).status
		).toBe(200);
		expect(
			(await h.visit(site.slug, "bob", `/_ryu/shared/board/${record.id}`))
				.status
		).toBe(404);
		// The reserved storage owner is never a visitor identity.
		expect(
			(
				await h.visit(site.slug, "reserved", "/_ryu/shared/board", "POST", {
					value: 1,
				})
			).status
		).toBe(403);
	});

	test("editors-only writing and private audiences are enforced", async () => {
		const h = harness();
		const site = await h.site(
			"shared-editors",
			{ enabled: true, write: "editors" },
			"invited"
		);
		expect((await h.visit(site.slug, null, "/_ryu/shared/board")).status).toBe(
			403
		);
		expect(
			(await h.visit(site.slug, "alice", "/_ryu/shared/board")).status
		).toBe(403);
		expect(
			(
				await h.visit(site.slug, "editor", "/_ryu/shared/board", "POST", {
					value: "status: green",
				})
			).status
		).toBe(201);
		const owner = listResponse.parse(
			await (await h.visit(site.slug, "owner", "/_ryu/shared/board")).json()
		);
		expect(owner.records).toHaveLength(1);
		expect(owner.records[0]?.canModify).toBe(true);
	});

	test("rejects lost updates with a 409 that returns the current record", async () => {
		const h = harness();
		const site = await h.site("shared-conflict");
		const path = "/_ryu/shared/tasks/task-1";
		expect(
			(await h.visit(site.slug, "alice", path, "PUT", { value: "draft" }))
				.status
		).toBe(201);
		const blind = await h.visit(site.slug, "alice", path, "PUT", {
			value: "blind overwrite",
		});
		expect(blind.status).toBe(409);
		const blindBody = await blind.json();
		expect(blindBody.error.code).toBe("conflict");
		expect(blindBody.current).toMatchObject({ revision: 1, value: "draft" });
		expect(
			(
				await h.visit(site.slug, "alice", path, "PUT", {
					value: "first",
					expectedRevision: 1,
				})
			).status
		).toBe(200);
		const stale = await h.visit(site.slug, "editor", path, "PUT", {
			value: "second",
			expectedRevision: 1,
		});
		expect(stale.status).toBe(409);
		expect((await stale.json()).current.value).toBe("first");
		expect(
			(
				await h.visit(
					site.slug,
					"alice",
					`${path}?expectedRevision=1`,
					"DELETE"
				)
			).status
		).toBe(409);
		expect(
			(
				await h.visit(site.slug, "alice", "/_ryu/shared/tasks/gone", "PUT", {
					value: 1,
					expectedRevision: 4,
				})
			).status
		).toBe(409);
	});

	test("enforces value, name, record and write-rate limits", async () => {
		const h = harness();
		const site = await h.site("shared-limits");
		expect(
			(
				await h.visit(site.slug, "alice", "/_ryu/shared/board", "POST", {
					value: "x".repeat(SITE_LIMITS.sharedRecordBytes + 10),
				})
			).status
		).toBe(413);
		expect(
			(await h.visit(site.slug, "alice", "/_ryu/shared/9bad")).status
		).toBe(400);
		expect(
			(
				await h.visit(site.slug, "alice", "/_ryu/shared/board/events", "PUT", {
					value: 1,
				})
			).status
		).toBe(405);
		const binding = site.settings.database;
		if (!binding) {
			throw new Error("database binding expected");
		}
		await h.database.importRecords(
			binding,
			Array.from({ length: SITE_LIMITS.sharedRecords }, (_, index) => ({
				owner: SHARED_RECORDS_OWNER,
				collection: "filler",
				key: `r${index}`,
				value: JSON.stringify({
					author: "alice",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					revision: 1,
					value: index,
				}),
			}))
		);
		const full = await h.visit(site.slug, "bob", "/_ryu/shared/board", "POST", {
			value: "one too many",
		});
		expect(full.status).toBe(429);
		expect((await full.json()).error.code).toBe("quota");
		// The owner database view counts shared records separately.
		const status = await h.admin(`/projects/${site.id}/database`);
		expect((await status.json()).sharedRecords).toBe(SITE_LIMITS.sharedRecords);
		// Pages read the collection a page at a time.
		const first = listResponse.parse(
			await (
				await h.visit(site.slug, "bob", "/_ryu/shared/filler?limit=200")
			).json()
		);
		expect(first.records).toHaveLength(200);
		expect(first.nextCursor).toBe(first.records.at(-1)?.id ?? "");
		const second = listResponse.parse(
			await (
				await h.visit(
					site.slug,
					"bob",
					`/_ryu/shared/filler?limit=200&cursor=${first.nextCursor}`
				)
			).json()
		);
		expect(second.records[0]?.id > (first.nextCursor ?? "")).toBe(true);

		const rate = await h.site("shared-rate");
		let refused = 0;
		for (
			let index = 0;
			index <= SITE_LIMITS.sharedWritesPerVisitorPerMinute;
			index += 1
		) {
			const response = await h.visit(
				rate.slug,
				"alice",
				`/_ryu/shared/clicks/c${index}`,
				"PUT",
				{ value: index }
			);
			if (response.status === 429) {
				refused += 1;
			}
		}
		expect(refused).toBe(1);
		expect(
			(
				await h.visit(rate.slug, "bob", "/_ryu/shared/clicks/bob", "PUT", {
					value: 1,
				})
			).status
		).toBe(201);
	});

	test("hold each author to their share of shared records", async () => {
		const h = harness();
		const site = await h.site("shared-share");
		const binding = site.settings.database;
		if (!binding) {
			throw new Error("database binding expected");
		}
		// Alice already holds her full record share.
		await h.database.importRecords(
			binding,
			Array.from(
				{ length: SITE_LIMITS.sharedRecordsPerAuthor },
				(_, index) => ({
					owner: SHARED_RECORDS_OWNER,
					collection: "board",
					key: `a${index}`,
					value: envelope("alice", index),
				})
			)
		);
		const refused = await h.visit(
			site.slug,
			"alice",
			"/_ryu/shared/board",
			"POST",
			{ value: "one more" }
		);
		expect(refused.status).toBe(429);
		expect((await refused.json()).error.code).toBe("quota");
		// Replacing a record she owns without growing her usage still works.
		expect(
			(
				await h.visit(site.slug, "alice", "/_ryu/shared/board/a0", "PUT", {
					value: 1,
					expectedRevision: 1,
				})
			).status
		).toBe(200);
		// Other visitors keep their own share.
		expect(
			(
				await h.visit(site.slug, "bob", "/_ryu/shared/board", "POST", {
					value: "bob's",
				})
			).status
		).toBe(201);

		// Bob fills his byte share with a few large records.
		const large = "y".repeat(SITE_LIMITS.sharedRecordBytes - 200);
		const count = Math.ceil(
			SITE_LIMITS.sharedBytesPerAuthor / SITE_LIMITS.sharedRecordBytes
		);
		await h.database.importRecords(
			binding,
			Array.from({ length: count }, (_, index) => ({
				owner: SHARED_RECORDS_OWNER,
				collection: "notes",
				key: `b${index}`,
				value: envelope("bob", large),
			}))
		);
		const tooMuch = await h.visit(
			site.slug,
			"bob",
			"/_ryu/shared/notes",
			"POST",
			{ value: "small" }
		);
		expect(tooMuch.status).toBe(429);
		expect((await tooMuch.json()).error.code).toBe("quota");
		// Shrinking a record frees room again.
		expect(
			(
				await h.visit(site.slug, "bob", "/_ryu/shared/notes/b0", "PUT", {
					value: "short",
					expectedRevision: 1,
				})
			).status
		).toBe(200);
		expect(
			(
				await h.visit(site.slug, "bob", "/_ryu/shared/notes", "POST", {
					value: "small",
				})
			).status
		).toBe(201);
		// An editor growing Bob's record is charged to Bob's share.
		expect(
			(
				await h.visit(site.slug, "editor", "/_ryu/shared/notes/b0", "PUT", {
					value: large,
					expectedRevision: 2,
				})
			).status
		).toBe(429);
	});

	test("drops a live stream whose subscriber stops reading", async () => {
		const h = harness();
		const site = await h.site("shared-slow");
		const hub = createSharedRecordsHub();
		const url = new URL(
			`http://${site.slug}.localhost/_ryu/shared/board/events`
		);
		const open = (since?: string) =>
			handleSharedRecords({
				authorized: () => true,
				database: h.database,
				hub,
				keepOpen: () => undefined,
				readBody: async () => null,
				request: new Request(since ? `${url.href}?since=${since}` : url.href),
				site,
				url: since ? new URL(`${url.href}?since=${since}`) : url,
				user: null,
				visitor: "203.0.113.9",
			});
		const start = hub.cursor();
		const response = await open();
		expect(response?.status).toBe(200);
		expect(hub.streams(site.id)).toBe(1);
		// The body is never read, so every change would otherwise pile up.
		const events = Math.ceil(
			(SHARED_STREAM_BUFFER_BYTES * 2) / SITE_LIMITS.sharedRecordBytes
		);
		for (let index = 0; index < events; index += 1) {
			hub.publish(site.id, largeChange(`r${index}`));
		}
		expect(hub.streams(site.id)).toBe(0);
		await response?.body?.cancel().catch(() => undefined);

		// A reconnect whose missed changes exceed the stream buffer is told to
		// list again rather than being sent the whole backlog at once.
		const resumed = await open(start);
		const reader = resumed?.body?.getReader();
		let text = "";
		const decoder = new TextDecoder();
		while (reader && !text.includes("event: reset")) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			text += decoder.decode(chunk.value);
		}
		await reader?.cancel();
		expect(text).toContain("event: reset");
		expect(text).not.toContain("event: change");
	});

	test("streams changes to subscribers and replays them after Last-Event-ID", async () => {
		const h = harness();
		const site = await h.site("shared-live");
		const listed = listResponse.parse(
			await (await h.visit(site.slug, "bob", "/_ryu/shared/game")).json()
		);
		const controller = new AbortController();
		const events = await fetch(
			`http://127.0.0.1:${h.server.visitor.port}/_ryu/shared/game/events?since=${listed.eventCursor}`,
			{
				headers: {
					host: `${site.slug}.localhost:${h.server.visitor.port}`,
					authorization: "Bearer bob",
				},
				signal: controller.signal,
			}
		);
		expect(events.status).toBe(200);
		expect(events.headers.get("content-type")).toContain("text/event-stream");
		const reader = events.body?.getReader();
		if (!reader) {
			throw new Error("stream expected");
		}
		const decoder = new TextDecoder();
		let text = "";
		const until = async (needle: string) => {
			while (!text.includes(needle)) {
				const chunk = await reader.read();
				if (chunk.done) {
					throw new Error(`stream ended before ${needle}: ${text}`);
				}
				text += decoder.decode(chunk.value);
			}
		};
		await until("event: ready");
		const move = await h.visit(
			site.slug,
			"alice",
			"/_ryu/shared/game/move-1",
			"PUT",
			{ value: { x: 1, y: 2 } }
		);
		expect(move.status).toBe(201);
		await until('"move-1"');
		const change = /id: (\S+)\nevent: change\ndata: (.+)\n\n/.exec(text);
		expect(change).not.toBeNull();
		const payload = JSON.parse(change?.[2] ?? "{}");
		expect(payload).toMatchObject({
			type: "set",
			collection: "game",
			id: "move-1",
			record: { value: { x: 1, y: 2 }, mine: false, canModify: false },
		});
		controller.abort();
		// A reconnect from before the change receives it again.
		const resumed = await fetch(
			`http://127.0.0.1:${h.server.visitor.port}/_ryu/shared/game/events`,
			{
				headers: {
					host: `${site.slug}.localhost:${h.server.visitor.port}`,
					"last-event-id": listed.eventCursor,
				},
			}
		);
		const resumedReader = resumed.body?.getReader();
		let resumedText = "";
		while (resumedReader && !resumedText.includes("event: ready")) {
			const chunk = await resumedReader.read();
			if (chunk.done) {
				break;
			}
			resumedText += decoder.decode(chunk.value);
		}
		await resumedReader?.cancel();
		expect(resumedText).toContain('"id":"move-1"');
		// An unknown cursor (for example, from before a restart) asks for a reload.
		const reset = await fetch(
			`http://127.0.0.1:${h.server.visitor.port}/_ryu/shared/game/events?since=ffffffff-3`,
			{ headers: { host: `${site.slug}.localhost:${h.server.visitor.port}` } }
		);
		const resetReader = reset.body?.getReader();
		let resetText = "";
		while (resetReader && !resetText.includes("event: reset")) {
			const chunk = await resetReader.read();
			if (chunk.done) {
				break;
			}
			resetText += decoder.decode(chunk.value);
		}
		await resetReader?.cancel();
		expect(resetText).toContain("event: reset");
	});

	test("owner visitor-data purge removes a visitor's authored shared records", async () => {
		const h = harness();
		const site = await h.site("shared-purge");
		await h.visit(site.slug, "alice", "/_ryu/shared/board/a1", "PUT", {
			value: "from alice",
		});
		await h.visit(site.slug, "bob", "/_ryu/shared/board/b1", "PUT", {
			value: "from bob",
		});
		const report = await (
			await h.admin(`/projects/${site.id}/visitors`)
		).json();
		const owners = report.visitors.map(
			(entry: { owner: string; sharedRecords: number }) => [
				entry.owner,
				entry.sharedRecords,
			]
		);
		expect(owners).toContainEqual(["alice", 1]);
		expect(owners).not.toContainEqual([SHARED_RECORDS_OWNER, 2]);
		expect(
			(
				await h.admin(
					`/projects/${site.id}/visitors/${visitorKey(SHARED_RECORDS_OWNER)}/data`,
					"DELETE"
				)
			).status
		).toBe(400);
		const purge = await h.admin(
			`/projects/${site.id}/visitors/${visitorKey("alice")}/data`,
			"DELETE"
		);
		expect(purge.status).toBe(200);
		expect((await purge.json()).deleted.records).toBe(1);
		const remaining = listResponse.parse(
			await (await h.visit(site.slug, null, "/_ryu/shared/board")).json()
		);
		expect(remaining.records.map((record) => record.id)).toEqual(["b1"]);
	});
});

describe("shared records change feed", () => {
	test("asks for a reload once changes fall out of the replay window", () => {
		const hub = createSharedRecordsHub({ epoch: "abcd1234", replay: 2 });
		const start = hub.cursor();
		for (const id of ["a", "b", "c"]) {
			hub.publish("site", { type: "delete", collection: "c", id });
		}
		expect(hub.since("site", "c", start)).toBeNull();
		expect(hub.since("site", "c", "abcd1234-1")?.map((e) => e.seq)).toEqual([
			2, 3,
		]);
		expect(hub.since("site", "other", start)).toEqual([]);
		expect(hub.since("site", "c", "other-1")).toBeNull();
		expect(hub.since("site", "c", "abcd1234-99")).toBeNull();
	});

	test("bounds replay history across collections", () => {
		const hub = createSharedRecordsHub({
			epoch: "abcd1234",
			replayBytes: SITE_LIMITS.sharedRecordBytes * 5,
		});
		const start = hub.cursor();
		hub.publish("site", largeChange("kept-early"));
		const afterFirst = hub.cursor();
		// One collection name per change, as a create-then-delete loop would use.
		for (let index = 0; index < 50; index += 1) {
			hub.publish("site", {
				...largeChange(`r${index}`),
				collection: `c${index}`,
			});
		}
		expect(hub.historyBytes()).toBeLessThanOrEqual(
			SITE_LIMITS.sharedRecordBytes * 5
		);
		// Forgotten collections ask cursors from before the eviction to reload.
		expect(hub.since("site", "board", start)).toBeNull();
		expect(hub.since("site", "c0", afterFirst)).toBeNull();
		// A collection that keeps changing still replays its own history.
		hub.publish("site", { ...largeChange("first"), collection: "live" });
		const liveCursor = hub.cursor();
		hub.publish("site", { ...largeChange("second"), collection: "live" });
		expect(
			hub.since("site", "live", liveCursor)?.map((e) => e.change.id)
		).toEqual(["second"]);
		// A collection with no history replays nothing after the newest cursor.
		expect(hub.since("site", "quiet", hub.cursor())).toEqual([]);
		hub.forget("site");
		expect(hub.historyBytes()).toBe(0);
	});
});
