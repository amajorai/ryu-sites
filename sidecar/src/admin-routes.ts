/**
 * The management listener's route table. Every response passes the same
 * pipeline as before: Brotli bodies are refused, errors become the Sites
 * envelope, each response carries `X-Request-ID` (and a bearer challenge on
 * 401), and a successful agent-tool mutation is audited.
 *
 * `/health`, the instance proof and the standalone home are public; every
 * other route signs the caller in first. Each authenticated route is served at
 * `/<path>` and `/api/sites/<path>`. A route answers only a request whose raw
 * path and method match it exactly (the router relaxes case, slashes and
 * `HEAD`); anything else, and anything no route names, gets the `*` fallback,
 * which serves no endpoint: it answers the former 401, 403 or 404 envelope.
 */
import { bearerOk } from "@ryu/sidecar-runtime";
import type { RouteMethod } from "@ryu/sidecar-runtime/effect-http";
import { Effect } from "effect";
import type { HttpRouter } from "effect/http";
import { OWNER_ACTIONS } from "./admin-owner-routes.ts";
import {
	type AdminCall,
	SITE_ACTIONS,
	SITE_PATH,
	type SiteAction,
	serveSiteAction,
} from "./admin-site-routes.ts";
import { ADMIN_ENDPOINTS } from "./admin-top-routes.ts";
import {
	attempt,
	type Endpoint,
	type RouteFailure,
	recover,
	refuse,
	sitesRoute,
} from "./effect-routes.ts";
import {
	managementChallenge,
	newRequestId,
	REQUEST_ID_HEADER,
	withHeaders,
} from "./http-conventions.ts";
import {
	INSTANCE_PROOF_PATH,
	instanceChallengeSchema,
	instanceProof,
} from "./instance-proof.ts";
import {
	auditAgentMutation,
	SITES_AGENT_CLIENT,
	SITES_AGENT_CLIENT_HEADER,
} from "./server-audit.ts";
import type { SitesContext } from "./server-context.ts";
import { json, rejectBrotliRequest } from "./server-http.ts";
import { SITES_SERVICE_NAME, SITES_SERVICE_VERSION } from "./service-info.ts";

/** A public endpoint, answered before sign-in. */
interface PublicEndpoint {
	matches: (url: URL, request: Request) => boolean;
	method: RouteMethod;
	path: HttpRouter.PathInput;
	serve: (request: Request, url: URL) => Endpoint;
}

/** Set once the caller signs in, so only authenticated mutations are audited. */
interface Caller {
	id: string;
}

type Serve = (request: Request, url: URL, caller: Caller) => Endpoint;

const API_PREFIX = /^\/api\/sites(?=\/|$)/;
const PREFIXES = ["", "/api/sites"] as const;
const SITE_ENDPOINTS: readonly SiteAction[] = [
	...SITE_ACTIONS,
	...OWNER_ACTIONS,
];

const bearerOf = (request: Request) =>
	request.headers.get("authorization") ?? undefined;

const NO_STORE = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};

/** The management pipeline around one route's handler. */
const managed = (context: SitesContext, serve: Serve) => (request: Request) =>
	Effect.gen(function* () {
		const caller: Caller = { id: "" };
		const requestId = newRequestId();
		let response = yield* recover(
			Effect.suspend(() => {
				rejectBrotliRequest(request);
				return serve(request, new URL(request.url), caller);
			}),
			{ request, requestId }
		);
		// RFC 9110 §15.5.2: a 401 names how to authenticate. Every management
		// response carries its request id.
		response = withHeaders(response, {
			[REQUEST_ID_HEADER]: requestId,
			...(response.status === 401 && !response.headers.has("www-authenticate")
				? { "www-authenticate": managementChallenge(request) }
				: {}),
		});
		if (
			caller.id &&
			request.headers.get(SITES_AGENT_CLIENT_HEADER) === SITES_AGENT_CLIENT &&
			bearerOk(bearerOf(request), context.options.token)
		) {
			// The mutation already committed; a failed audit write must not
			// turn its confirmed result into an apparent failure the agent retries.
			yield* Effect.promise(() =>
				auditAgentMutation(context.store, request, response, caller.id).catch(
					() => console.warn("[ryu-sites] agent audit entry was not recorded")
				)
			);
		}
		return response;
	});

/**
 * Signs the caller in. A standalone process is one tenant with one management
 * bearer: a visitor session never manages Sites there, because its origin
 * check trusts the Host header, which a direct client can set to any Site.
 */
const signIn = (
	context: SitesContext,
	request: Request,
	url: URL,
	caller: Caller
): Effect.Effect<AdminCall, RouteFailure> =>
	Effect.gen(function* () {
		const { services, options, standalone, owner } = context;
		const user = yield* attempt(async () => {
			if (bearerOk(bearerOf(request), options.token)) {
				return services.managementIdentity
					? await services.managementIdentity(request)
					: owner;
			}
			return standalone ? null : ((await services.identity?.(request)) ?? null);
		});
		if (!user) {
			return yield* refuse("unauthorized", "Sign in to manage Sites", 401);
		}
		caller.id = user.id;
		return { request, url, user, path: url.pathname.replace(API_PREFIX, "") };
	});

function publicEndpoints(context: SitesContext): PublicEndpoint[] {
	const { options } = context;
	const endpoints: PublicEndpoint[] = [
		{
			method: "*",
			path: "/health",
			matches: (url) => url.pathname === "/health",
			serve: () => Effect.succeed(json({ ok: true })),
		},
		{
			// Unauthenticated by design: it proves this process holds the secret
			// recorded in the owner-only endpoint file, and reveals only an HMAC
			// of the caller's fresh challenge.
			method: "*",
			path: INSTANCE_PROOF_PATH as HttpRouter.PathInput,
			matches: (url) => url.pathname === INSTANCE_PROOF_PATH,
			serve: (request, url) =>
				Effect.gen(function* () {
					if (request.method !== "GET" || !options.instanceSecret) {
						return yield* refuse("not_found", "Not found", 404);
					}
					const challenge = instanceChallengeSchema.safeParse(
						url.searchParams.get("challenge")
					);
					if (!challenge.success) {
						return yield* refuse(
							"invalid_input",
							"A 64-character hex challenge is required"
						);
					}
					return Response.json(
						{ proof: instanceProof(options.instanceSecret, challenge.data) },
						{ headers: NO_STORE }
					);
				}),
		},
	];
	if (context.standalone) {
		// The standalone home redirects only to an operator-set dashboard (Ryu's
		// hosted deployment sets one), like the Gateway; otherwise it describes
		// the service. Core-managed Sites keeps its bearer-only behavior.
		endpoints.push({
			method: "GET",
			path: "/",
			matches: (url, request) =>
				url.pathname === "/" && request.method === "GET",
			serve: () =>
				Effect.sync(() => {
					const dashboard = options.dashboardUrl?.trim();
					return dashboard
						? new Response(null, {
								status: 307,
								headers: { "cache-control": "no-store", location: dashboard },
							})
						: json({
								name: SITES_SERVICE_NAME,
								version: SITES_SERVICE_VERSION,
								health: "/health",
							});
				}),
		});
	}
	return endpoints;
}

/**
 * What a signed-in call no route serves gets: under `/projects/:siteId`, the
 * whole Site permission chain to its 403 or "Operation not found" 404 (or the
 * Site's own 404); anywhere else, "Route not found". It never runs an endpoint.
 */
function notFound(context: SitesContext, call: AdminCall): Endpoint {
	const site = SITE_PATH.exec(call.path);
	if (!site) {
		return refuse("not_found", "Route not found", 404);
	}
	return attempt(() =>
		serveSiteAction(context, call, site[1] ?? "", site[2] ?? "", undefined)
	);
}

/**
 * The listener's answer for a request no route matches exactly: sign-in (its
 * 401), then the not-found walk. Public endpoints always have their own route.
 */
const unrouted =
	(context: SitesContext): Serve =>
	(request, url, caller) =>
		Effect.flatMap(signIn(context, request, url, caller), (call) =>
			notFound(context, call)
		);

/** The management route table. */
export function adminRoutes(context: SitesContext) {
	const fallback = unrouted(context);
	const route = (
		method: RouteMethod,
		path: HttpRouter.PathInput,
		serve: Serve
	) => sitesRoute(method, path, managed(context, serve));
	const signedIn = (
		matches: (path: string, request: Request) => boolean,
		serve: (call: AdminCall) => Endpoint
	): Serve => {
		return (request, url, caller) =>
			matches(url.pathname.replace(API_PREFIX, ""), request)
				? Effect.flatMap(signIn(context, request, url, caller), serve)
				: fallback(request, url, caller);
	};
	return [
		...publicEndpoints(context).map((endpoint) =>
			route(endpoint.method, endpoint.path, (request, url, caller) =>
				endpoint.matches(url, request)
					? endpoint.serve(request, url)
					: fallback(request, url, caller)
			)
		),
		...PREFIXES.flatMap((prefix) => [
			...ADMIN_ENDPOINTS.map((endpoint) =>
				route(
					endpoint.method,
					`${prefix}${endpoint.path}`,
					signedIn(endpoint.matches, (call) => endpoint.serve(context, call))
				)
			),
			...SITE_ENDPOINTS.map((action) =>
				route(
					action.method,
					`${prefix}/projects/:siteId${action.route}` as HttpRouter.PathInput,
					signedIn(
						(path, request) => {
							const site = SITE_PATH.exec(path);
							return (
								site !== null &&
								request.method === action.method &&
								action.matches(site[2] ?? "")
							);
						},
						(call) => {
							const site = SITE_PATH.exec(call.path);
							const name = site?.[2] ?? "";
							return attempt(() =>
								serveSiteAction(context, call, site?.[1] ?? "", name, action)
							);
						}
					)
				)
			),
		]),
		route("*", "*", fallback),
	];
}
