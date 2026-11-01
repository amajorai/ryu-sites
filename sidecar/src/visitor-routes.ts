/**
 * The visitor listener's route table. Every Site is served from its own host,
 * so each route first resolves and authorizes the Site (`./visitor-gate.ts`)
 * and then serves its endpoint. A route answers only a request whose raw path
 * and method match it exactly. `*` is the final fallback and serves no
 * endpoint: after the same Site checks it answers the deployed page for
 * `GET`/`HEAD` on any other path (Sites own their paths), the `/_ryu/` 404
 * envelope, or the 405 envelope, exactly as before.
 */

import { createHmac } from "node:crypto";
import { injectPoweredByRyu } from "@ryu/sidecar-runtime/branding";
import {
	bunServerOf,
	type RouteMethod,
} from "@ryu/sidecar-runtime/effect-http";
import type { HttpRouter } from "effect/http";
import { EDGE_READY_PATH } from "./edge-readiness.ts";
import { attempt, recover, sitesRoute } from "./effect-routes.ts";
import {
	deployedExtensions,
	handleConnections,
	sitePlugin,
} from "./extension-routes.ts";
import type { SitesContext } from "./server-context.ts";
import { body, fail, json } from "./server-http.ts";
import { handleSharedRecords } from "./shared-records.ts";
import { generalAiEnabled } from "./visitor-ai.ts";
import { DATA_ENDPOINTS, type DataCall, dataNotFound } from "./visitor-data.ts";
import {
	authorizeVisit,
	edgeReady,
	isEdgeReadyProbe,
	resolveVisit,
	type SiteVisit,
	serveSiteMcp,
	type VisitorCall,
	type VisitorRequest,
	visitorRequest,
} from "./visitor-gate.ts";

type Serve = (call: VisitorCall) => Response | Promise<Response>;

const VISITOR_PAGE_CSP =
	"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Rate and quota key: the account ID, or the address when signed out. */
const visitorKey = (call: VisitorCall) =>
	call.user ? `user:${call.user.id}` : `address:${call.ip}`;

const dataCall = (context: SitesContext, call: VisitorCall): DataCall => ({
	request: call.request,
	url: call.url,
	site: call.site,
	user: call.user,
	store: context.store,
	services: context.services,
	quotaVisitor: visitorKey(call),
});

/** The deployed page: `GET`/`HEAD` on any path the Site owns. */
function page(context: SitesContext, call: VisitorCall): Response {
	const { baseDomain, options, store } = context;
	const { request, site, url } = call;
	const day = new Date().toISOString().slice(0, 10);
	const visitorId = createHmac("sha256", context.trafficSalt)
		.update(`${site.id}:${call.ip}:${request.headers.get("user-agent") ?? ""}`)
		.digest("hex")
		.slice(0, 24);
	if (request.method === "GET") {
		store.recordPageView(
			site.id,
			day,
			visitorId,
			url.pathname.slice(0, 512) || "/"
		);
	}
	const artifact = store.artifact(site.id, site.deploymentId);
	const html = options.poweredByRyu
		? injectPoweredByRyu(artifact, "sites")
		: artifact;
	const visitorHeaders = {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"permissions-policy":
			"camera=(), microphone=(), geolocation=(), payment=()",
		"content-security-policy": VISITOR_PAGE_CSP,
		"cross-origin-opener-policy": "same-origin",
		"cross-origin-resource-policy": "same-origin",
	};
	if (baseDomain !== "localhost") {
		Object.assign(visitorHeaders, {
			"strict-transport-security": "max-age=31536000",
		});
	}
	return new Response(request.method === "HEAD" ? null : html, {
		headers: visitorHeaders,
	});
}

/**
 * What an authorized request no route serves gets: the `/_ryu/` 404 (behind
 * its sign-in check), a 405 for other methods, or the page.
 */
function unrouted(context: SitesContext, call: VisitorCall) {
	if (call.url.pathname.startsWith("/_ryu/")) {
		return dataNotFound(dataCall(context, call));
	}
	if (call.request.method !== "GET" && call.request.method !== "HEAD") {
		return fail("method", "Method not allowed", 405);
	}
	return page(context, call);
}

/** Resolves and authorizes the Site, then lets `serve` answer. */
async function visitSite(
	context: SitesContext,
	visit: VisitorRequest,
	serve: (call: VisitorCall) => Response | Promise<Response>,
	mcp: boolean
): Promise<Response> {
	const resolved = await resolveVisit(context, visit);
	if (resolved instanceof Response) {
		return resolved;
	}
	const answered = mcp ? await serveSiteMcp(context, resolved) : null;
	if (answered) {
		return answered;
	}
	const authorized = await authorizeVisit(
		context,
		resolved satisfies SiteVisit
	);
	return authorized instanceof Response ? authorized : await serve(authorized);
}

/** Runs one visitor request with the listener's error envelope. */
const visitor =
	(
		context: SitesContext,
		serve: (visit: VisitorRequest) => Response | Promise<Response>
	) =>
	(incoming: Request) =>
		recover(
			attempt(() => serve(visitorRequest(context, incoming))),
			{ request: incoming }
		);

/** The Site checks, then the page, `/_ryu/` 404 or 405; no endpoint. */
const fallback = (context: SitesContext, visit: VisitorRequest) =>
	visitSite(context, visit, (call) => unrouted(context, call), false);

/** A route on a Site host; requests it does not match exactly fall back. */
const siteRoute = (
	context: SitesContext,
	method: RouteMethod,
	path: HttpRouter.PathInput,
	matches: (call: VisitorCall) => boolean,
	serve: Serve
) =>
	sitesRoute(
		method,
		path,
		visitor(context, (visit) =>
			visitSite(
				context,
				visit,
				(call) => (matches(call) ? serve(call) : unrouted(context, call)),
				false
			)
		)
	);

const at =
	(pathname: string, ...methods: string[]) =>
	({ url, request }: VisitorCall) =>
		url.pathname === pathname && methods.includes(request.method);

const SHARED_PATH = /^\/_ryu\/shared\/([^/]+)(?:\/([^/]+))?$/;

/** The visitor route table. */
export function visitorRoutes(context: SitesContext) {
	const { options, services, store, sharedHub } = context;
	const route = (
		method: RouteMethod,
		path: HttpRouter.PathInput,
		matches: (call: VisitorCall) => boolean,
		serve: Serve
	) => siteRoute(context, method, path, matches, serve);
	const runtimeConfig = ({ site }: VisitorCall) =>
		json({
			mode: site.settings.mode,
			knowledge: Boolean(site.settings.spaceId && services.retrieve),
			answers:
				site.settings.ai && Boolean(site.settings.spaceId && services.answer),
			completions: generalAiEnabled(site, services),
			aiAnonymous:
				generalAiEnabled(site, services) && site.settings.aiAnonymous,
			records: site.settings.storage,
			uploads: site.settings.uploads,
			sharedData:
				site.settings.sharedData.enabled &&
				site.settings.mode === "connected" &&
				Boolean(site.settings.database && services.spacesDatabase),
			sharedWrite: site.settings.sharedData.write,
			resetActions: false,
			signIn: Boolean(services.identity),
			remixable: site.settings.allowRemix,
		});
	const consent: Serve = (call) =>
		context.consent({
			request: call.request,
			site: call.site,
			user: call.user,
			store,
			services,
			body: () => body(call.request),
		});
	const connections: Serve = (call) =>
		handleConnections({
			request: call.request,
			site: call.site,
			user: call.user,
			store,
			services,
			body: () => body(call.request, 64_000),
		});
	const shared: Serve = async (call) =>
		(await handleSharedRecords({
			request: call.request,
			url: call.url,
			site: call.site,
			user: call.user,
			hub: sharedHub,
			database: services.spacesDatabase,
			readBody: (limit) => body(call.request, limit),
			// Event streams stay open past Bun's idle timeout.
			keepOpen: () => bunServerOf(call.incoming)?.timeout(call.incoming, 0),
			visitor: visitorKey(call),
			authorized: () => {
				try {
					const current = store.get(call.site.id);
					return (
						Boolean(current.deploymentId) &&
						current.settings.sharedData.enabled &&
						current.settings.mode === "connected" &&
						context.visitAllowed(current, call.user)
					);
				} catch {
					return false;
				}
			},
		})) ?? (await unrouted(context, call));
	return [
		// The edge probe precedes every Site check: it serves a domain that is
		// not active yet.
		sitesRoute(
			"GET",
			EDGE_READY_PATH,
			visitor(context, (visit) =>
				isEdgeReadyProbe(visit)
					? edgeReady(context, visit)
					: fallback(context, visit)
			)
		),
		...[
			"/mcp",
			"/sites/:siteId/mcp",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/sites/:siteId/mcp",
		].map((path) =>
			sitesRoute(
				"*",
				path as HttpRouter.PathInput,
				visitor(context, (visit) =>
					visitSite(context, visit, (call) => unrouted(context, call), true)
				)
			)
		),
		route(
			"GET",
			"/_ryu/runtime.js",
			at("/_ryu/runtime.js", "GET"),
			() =>
				new Response(options.visitorScript ?? "", {
					headers: {
						"content-type": "text/javascript",
						"x-content-type-options": "nosniff",
					},
				})
		),
		route("GET", "/_ryu/config", at("/_ryu/config", "GET"), runtimeConfig),
		route("GET", "/_ryu/identity", at("/_ryu/identity", "GET"), ({ user }) =>
			json(user ? { id: user.id, email: user.email } : null)
		),
		route(
			"GET",
			"/_ryu/manifest.json",
			(call) =>
				at("/_ryu/manifest.json", "GET")(call) &&
				deployedExtensions(call.site).mcp,
			({ site, url }) => json(sitePlugin(site, url.origin))
		),
		...(["GET", "POST"] as const).flatMap((method) => [
			route(
				method,
				"/_ryu/connections/consent",
				at("/_ryu/connections/consent", "GET", "POST"),
				consent
			),
			route(
				method,
				"/_ryu/connections",
				at("/_ryu/connections", "GET", "POST"),
				connections
			),
		]),
		route(
			"*",
			"/_ryu/shared/*",
			({ url }) => SHARED_PATH.test(url.pathname),
			shared
		),
		...DATA_ENDPOINTS.map((endpoint) =>
			route(
				endpoint.method,
				endpoint.path,
				(call) => endpoint.matches(dataCall(context, call)),
				(call) => endpoint.serve(dataCall(context, call))
			)
		),
		sitesRoute(
			"*",
			"*",
			visitor(context, (visit) => fallback(context, visit))
		),
	];
}
