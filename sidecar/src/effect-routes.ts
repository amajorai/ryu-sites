/**
 * The bridge between Sites' route handlers and the `effect/http` router.
 *
 * Handlers return the Web `Response` they always built, and the router sends
 * it unchanged (`HttpServerResponse.raw`), so headers, `Set-Cookie` lines and
 * streamed bodies stay byte-for-byte what the pre-Effect listeners sent.
 *
 * The router matches leniently (case-insensitive, ignoring trailing and
 * duplicate slashes, and serving `HEAD` from a `GET` route), while Sites always
 * matched the raw path, case and method exactly. Every route therefore names an
 * exact `match` on the raw request; a request the router sent there that does
 * not match exactly gets the listener's fallback, which serves no endpoint.
 *
 * The router also decodes the path, splits it at `;`, and refuses parameters
 * over 100 characters or a path whose escapes do not decode, none of which
 * Sites did. `routable` hands the router a copy of the request whose path keeps
 * every raw segment intact, so a request always reaches the route its raw path
 * names; the handler still sees the original request.
 */
import type { RouteMethod } from "@ryu/sidecar-runtime/effect-http";
import { Data, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type ErrorContext, siteErrorResponse } from "./server-http.ts";
import { SiteError } from "./store.ts";

/** A route handler failed; `cause` becomes the Sites error response. */
export class RouteFailure extends Data.TaggedError("RouteFailure")<{
	readonly cause: unknown;
}> {}

/** A route handler: the Web response, or a failure to render as an error. */
export type Endpoint = Effect.Effect<Response, RouteFailure>;

/** Runs an existing (possibly throwing) step; a throw becomes a failure. */
export const attempt = <A>(
	run: () => A | Promise<A>
): Effect.Effect<A, RouteFailure> =>
	Effect.tryPromise({
		try: async () => await run(),
		catch: (cause) => new RouteFailure({ cause }),
	});

/** Fails with a Sites error, as `fail()` does for plain handlers. */
export const refuse = (
	code: string,
	message: string,
	status = 400
): Effect.Effect<never, RouteFailure> =>
	Effect.fail(
		new RouteFailure({ cause: new SiteError(code, message, status) })
	);

/**
 * Renders a failure (or an unexpected defect) as the Sites error response for
 * `context`, exactly as the listeners' former try/catch did.
 */
export const recover = (
	endpoint: Endpoint,
	context: ErrorContext
): Effect.Effect<Response> =>
	endpoint.pipe(
		Effect.catchTag("RouteFailure", (failure) =>
			Effect.succeed(siteErrorResponse(failure.cause, context))
		),
		Effect.catchDefect((defect) =>
			Effect.succeed(siteErrorResponse(defect, context))
		)
	);

/** The router's default `maxParamLength`; no static segment is this long. */
const ROUTER_SEGMENT_LIMIT = 100;

/** The accepted request behind each routing copy `routable` made. */
const accepted = new WeakMap<Request, Request>();

/**
 * Escapes a raw path segment so the router's decoding yields it unchanged:
 * `%` cannot start an escape and `;` cannot end the path. Over-long segments
 * are shortened, since only their position (never their text) can match.
 */
const routingSegment = (segment: string) =>
	segment
		.slice(0, ROUTER_SEGMENT_LIMIT)
		.replaceAll("%", "%25")
		.replaceAll(";", "%3B");

/**
 * The request the router should match: the request itself, or (when its raw
 * path would be decoded, split or refused) a body-less copy at an escaped
 * path that routes by the raw segments. Route handlers get the original.
 */
export function routable(request: Request): Request {
	const url = new URL(request.url);
	const path = url.pathname.split("/").map(routingSegment).join("/");
	if (path === url.pathname) {
		return request;
	}
	try {
		const copy = new Request(`${url.origin}${path}${url.search}`, {
			method: request.method,
		});
		accepted.set(copy, request);
		return copy;
	} catch {
		// A method `Request` refuses: route the request as it came.
		return request;
	}
}

/** The Web request the listener accepted, unchanged. */
const webRequest = Effect.map(
	HttpServerRequest.HttpServerRequest,
	(request) => {
		const source = request.source as Request;
		return accepted.get(source) ?? source;
	}
);

/**
 * The router answers `HEAD` with an empty body of its own, which would drop
 * the `Content-Length` Bun used to report for the body it withheld. Name it
 * explicitly so a `HEAD` response keeps the length of the `GET` body.
 */
const withHeadLength = async (
	request: Request,
	response: Response
): Promise<Response> => {
	if (
		request.method !== "HEAD" ||
		response.body === null ||
		response.headers.has("content-length")
	) {
		return response;
	}
	const length = (await response.arrayBuffer()).byteLength;
	const headers = new Headers(response.headers);
	headers.set("content-length", String(length));
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};

/**
 * A router entry whose handler sees the original Web request and answers with
 * a Web response. Routes run to completion like the former Bun handlers did,
 * so a client that disconnects mid-mutation never skips its audit entry.
 */
export function sitesRoute(
	method: RouteMethod,
	path: HttpRouter.PathInput,
	handler: (request: Request) => Effect.Effect<Response>
): HttpRouter.Route<never> {
	return HttpRouter.route(
		method,
		path,
		Effect.flatMap(webRequest, (request) =>
			handler(request).pipe(
				Effect.flatMap((response) =>
					Effect.promise(() => withHeadLength(request, response))
				),
				Effect.map((response) => HttpServerResponse.raw(response))
			)
		),
		{ uninterruptible: true }
	);
}
