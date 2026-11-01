/**
 * The visitor data endpoints under `/_ryu/`: knowledge answers, search and
 * general AI, per-visitor records, and uploads. Each endpoint names its exact
 * path and method and applies the same gates, in the same order, as the
 * former single handler: Site mode first, then sign-in for saved data.
 *
 * The visitor router serves one route per endpoint; `visitorData` walks the
 * same list for the MCP tools, which replay visitor operations in-process.
 */
import type { RouteMethod } from "@ryu/sidecar-runtime/effect-http";
import type { HttpRouter } from "effect/http";
import { z } from "zod";
import {
	type RuntimeSite,
	resourceName,
	SHARED_RECORDS_OWNER,
	SITE_LIMITS,
	type SitePrincipal,
} from "./contracts.ts";
import { body, fail, json } from "./server-http.ts";
import type { SitesServices } from "./server-types.ts";
import { sharedRecordCount } from "./shared-records.ts";
import { FILE_DATA, FILE_NAME, type SitesStore } from "./store.ts";
import { complete, consumeAiAnswer } from "./visitor-ai.ts";

/** One visitor data request, with the Site it addresses. */
export interface DataCall {
	/** In memory only; stored counters hold the store's keyed digest of it. */
	quotaVisitor: string;
	request: Request;
	services: SitesServices;
	site: RuntimeSite;
	store: SitesStore;
	url: URL;
	user: SitePrincipal | null;
}

export interface DataEndpoint {
	/** Whether this endpoint serves the raw request (path, case and method). */
	matches: (call: DataCall) => boolean;
	method: RouteMethod;
	path: HttpRouter.PathInput;
	serve: (call: DataCall) => Promise<Response>;
}

const RECORD_PATH = /^\/_ryu\/records\/([^/]+)(?:\/([^/]+))?$/;
const FILE_PATH = /^\/_ryu\/files\/([a-f0-9-]+)$/;

/** Saved data needs the Connected to Ryu runtime. */
function requireConnected(site: RuntimeSite) {
	if (site.settings.mode !== "connected") {
		fail("disabled", "This Site uses browser-local data", 403);
	}
}

/** Records and files need a verified visitor. */
function requireSignedIn(call: DataCall): SitePrincipal {
	requireConnected(call.site);
	if (!call.user) {
		return fail("unauthorized", "Sign in to use saved records and files", 401);
	}
	return call.user;
}

const notFound = (): never => fail("not_found", "Resource not found", 404);

const queryInput = z
	.object({ query: z.string().trim().min(1).max(2000) })
	.strict();

async function ask(call: DataCall): Promise<Response> {
	const { request, services, site, store } = call;
	requireConnected(site);
	if (!(site.settings.ai && site.settings.spaceId && services.answer)) {
		return fail("unavailable", "Answers are unavailable for this Site", 503);
	}
	const input = queryInput.parse(await body(request, 10_000));
	consumeAiAnswer(store, site, call.quotaVisitor);
	return json(
		await services.answer(site.id, site.settings.spaceId, input.query)
	);
}

async function search(call: DataCall): Promise<Response> {
	const { request, services, site } = call;
	requireConnected(site);
	if (!(site.settings.spaceId && services.retrieve)) {
		return fail("unavailable", "No knowledge source is bound", 503);
	}
	const input = queryInput.parse(await body(request, 10_000));
	return json(
		await services.retrieve(site.id, site.settings.spaceId, input.query)
	);
}

async function records(call: DataCall): Promise<Response> {
	const { request, services, site } = call;
	const user = requireSignedIn(call);
	const record = RECORD_PATH.exec(call.url.pathname);
	if (!site.settings.storage) {
		return fail("disabled", "Record storage is disabled", 403);
	}
	const binding = site.settings.database;
	if (!(binding && services.spacesDatabase)) {
		return fail(
			"unavailable",
			"The Site's Ryu Spaces database is unavailable",
			503
		);
	}
	if (user.id === SHARED_RECORDS_OWNER) {
		return fail("forbidden", "This account cannot save records", 403);
	}
	const collection = resourceName.parse(record?.[1]);
	const key = record?.[2] ? resourceName.parse(record[2]) : null;
	const database = services.spacesDatabase;
	if (request.method === "GET") {
		return json(await database.records(binding, user.id, collection, key));
	}
	if (!key) {
		return fail("invalid_input", "A record key is required");
	}
	if (request.method === "DELETE") {
		const deleted = await database.deleteRecord(
			binding,
			user.id,
			collection,
			key
		);
		return json({ deleted });
	}
	if (request.method !== "PUT") {
		return notFound();
	}
	const value = JSON.stringify(await body(request, SITE_LIMITS.recordBytes));
	if (!z.string().safeParse(value).success) {
		return fail("invalid_input", "Record must be a JSON value");
	}
	const existing = await database.records(binding, user.id, collection, key);
	// Shared records have their own Site-wide cap, so only per-visitor
	// records count toward this one.
	const ownRecords = existing.length
		? 0
		: (await database.count(binding)) -
			(await sharedRecordCount(database, binding));
	if (existing.length === 0 && ownRecords >= SITE_LIMITS.records) {
		return fail("quota", "Record limit reached", 429);
	}
	await database.saveRecord(binding, {
		owner: user.id,
		collection,
		key,
		value: z.string().parse(value),
	});
	return json({ saved: true });
}

async function upload(call: DataCall): Promise<Response> {
	const { request, site, store } = call;
	const user = requireSignedIn(call);
	if (!site.settings.uploads) {
		return fail("disabled", "Uploads are disabled", 403);
	}
	const input = z
		.object({
			name: z.string().min(1).max(200),
			data: z.string().max(6_700_000),
		})
		.strict()
		.parse(await body(request, 6_800_000));
	const data = Buffer.from(input.data, "base64");
	if (data.length > SITE_LIMITS.fileBytes) {
		return fail("quota", "File exceeds 5 MB", 413);
	}
	const own = z
		.object({ count: z.number(), bytes: z.number() })
		.parse(
			store.db
				.query(
					"SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(size, LENGTH(data))),0) AS bytes FROM files WHERE site=? AND owner=?"
				)
				.get(site.id, user.id)
		);
	if (
		own.count >= SITE_LIMITS.filesPerVisitor ||
		own.bytes + data.length > SITE_LIMITS.fileBytesPerVisitor
	) {
		return fail(
			"quota",
			"You have reached your upload limit for this Site",
			429
		);
	}
	const count = z
		.object({ count: z.number() })
		.parse(
			store.db
				.query("SELECT COUNT(*) AS count FROM files WHERE site=?")
				.get(site.id)
		);
	if (count.count >= SITE_LIMITS.files) {
		return fail("quota", "File limit reached", 429);
	}
	const id = crypto.randomUUID();
	// The upload and its name are sealed at rest; `size` is the plaintext
	// length the quotas count.
	store.db
		.query(
			"INSERT INTO files(site, owner, id, name, type, data, size) VALUES(?,?,?,?,?,?,?)"
		)
		.run(
			site.id,
			user.id,
			id,
			store.seal.sealText(FILE_NAME, { id }, input.name),
			"application/octet-stream",
			store.seal.sealBytes(FILE_DATA, { id }, data),
			data.length
		);
	return json({ id, name: input.name, bytes: data.length }, 201);
}

function file(call: DataCall): Response {
	const { request, site, store } = call;
	const user = requireSignedIn(call);
	const id = FILE_PATH.exec(call.url.pathname)?.[1] ?? "";
	const row = z
		.object({ data: z.instanceof(Uint8Array) })
		.nullable()
		.parse(
			store.db
				.query("SELECT data FROM files WHERE site=? AND owner=? AND id=?")
				.get(site.id, user.id, id)
		);
	if (!row) {
		return fail("not_found", "File not found", 404);
	}
	if (request.method === "GET") {
		const plain = store.seal.openBytes(FILE_DATA, { id }, row.data);
		return new Response(new Uint8Array(plain), {
			headers: {
				"content-type": "application/octet-stream",
				"content-disposition": "attachment",
				"x-content-type-options": "nosniff",
				"cache-control": "no-store",
			},
		});
	}
	if (request.method === "DELETE") {
		store.db
			.query("DELETE FROM files WHERE site=? AND owner=? AND id=?")
			.run(site.id, user.id, id);
		return json({ deleted: true });
	}
	return notFound();
}

const at =
	(pathname: string, method: string) =>
	({ url, request }: DataCall) =>
		url.pathname === pathname && request.method === method;

/** Every `/_ryu/` data endpoint, in the order the former handler tried them. */
export const DATA_ENDPOINTS: readonly DataEndpoint[] = [
	{
		method: "POST",
		path: "/_ryu/reset",
		matches: at("/_ryu/reset", "POST"),
		// Visitor cookies authenticate page content too; only the trusted
		// Companion's Core hop runs reset checks.
		serve: async () =>
			fail("forbidden", "Run reset checks from Ryu Sites Settings", 403),
	},
	{
		method: "POST",
		path: "/_ryu/ask",
		matches: at("/_ryu/ask", "POST"),
		serve: ask,
	},
	{
		method: "POST",
		path: "/_ryu/complete",
		matches: at("/_ryu/complete", "POST"),
		serve: async (call) => {
			requireConnected(call.site);
			return await complete(
				call.request,
				call.site,
				call.user,
				call.store,
				call.services,
				call.quotaVisitor
			);
		},
	},
	{
		method: "POST",
		path: "/_ryu/search",
		matches: at("/_ryu/search", "POST"),
		serve: search,
	},
	{
		method: "*",
		path: "/_ryu/records/*",
		matches: ({ url }) => RECORD_PATH.test(url.pathname),
		serve: records,
	},
	{
		method: "POST",
		path: "/_ryu/files",
		matches: at("/_ryu/files", "POST"),
		serve: upload,
	},
	{
		method: "*",
		path: "/_ryu/files/:fileId",
		matches: ({ url, site }) =>
			FILE_PATH.test(url.pathname) && site.settings.uploads,
		serve: async (call) => file(call),
	},
];

/** A `/_ryu/` request no endpoint serves: the same gates, then 404. */
export async function dataNotFound(call: DataCall): Promise<Response> {
	requireSignedIn(call);
	return notFound();
}

/**
 * Serves one `/_ryu/` data request by path. The MCP tools replay visitor
 * operations through it; the visitor listener routes them directly.
 */
export async function visitorData(
	request: Request,
	url: URL,
	site: RuntimeSite,
	user: SitePrincipal | null,
	store: SitesStore,
	services: SitesServices,
	quotaVisitor: string
): Promise<Response> {
	const call = { request, url, site, user, store, services, quotaVisitor };
	const endpoint = DATA_ENDPOINTS.find((candidate) => candidate.matches(call));
	return endpoint ? await endpoint.serve(call) : await dataNotFound(call);
}
