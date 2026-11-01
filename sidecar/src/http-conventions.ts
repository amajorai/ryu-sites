/**
 * HTTP conventions Sites shares with the control-plane API host
 * (`apps/server/src/{problem-details,rate-limit-headers,api-auth-challenge}.ts`):
 * RFC 9457 problem details negotiated by Accept, an RFC 6750 `WWW-Authenticate`
 * challenge on management 401s, the IETF `RateLimit` / `RateLimit-Policy`
 * fields with `Retry-After` on the visitor rate limit, and `X-Request-ID` on
 * management responses. Sites is an app satellite that must not depend on
 * Core or the control plane, so these are local copies of the same formats.
 *
 * Every change is additive: a caller that does not name
 * `application/problem+json` keeps the `{ error: { code, message, fields? } }`
 * body it always received.
 */
import { SiteError } from "./store.ts";

export const PROBLEM_JSON_CONTENT_TYPE = "application/problem+json";

/** Public documentation for the Sites management API's error codes. */
export const SITES_ERRORS_DOCS_URL =
	"https://docs.ryuhq.com/docs/standalone/sites-api";

/** Realm named in the management listener's bearer challenge. */
export const SITES_AUTH_REALM = "ryu-sites";

export const REQUEST_ID_HEADER = "x-request-id";

const STATUS_TITLES: Readonly<Record<number, string>> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	413: "Content Too Large",
	415: "Unsupported Media Type",
	422: "Unprocessable Content",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

/** The RFC 9110 reason phrase for `status`, as the problem `title`. */
export function statusTitle(status: number): string {
	return (
		STATUS_TITLES[status] ?? (status >= 500 ? "Server Error" : "Client Error")
	);
}

/**
 * The section of the Sites API page that lists the error codes. Its heading
 * ("Revisions and errors") gives it this anchor; the page has no per-code
 * anchors, so a `#<code>` fragment would not resolve.
 */
export const SITES_ERRORS_DOCS_ANCHOR = "revisions-and-errors";

/**
 * The problem `type` URI (and `docs` link) of every Sites error: the page
 * section that documents the codes. The `code` member tells codes apart.
 */
export const SITES_PROBLEM_TYPE = `${SITES_ERRORS_DOCS_URL}#${SITES_ERRORS_DOCS_ANCHOR}`;

/**
 * Whether `Accept` names `application/problem+json` with a non-zero quality.
 * Wildcards and `application/json` do not count, so every existing client
 * keeps the legacy body.
 */
export function acceptsProblemJson(accept: string | null): boolean {
	if (!accept) {
		return false;
	}
	for (const range of accept.split(",")) {
		const [mediaType = "", ...params] = range.split(";");
		if (mediaType.trim().toLowerCase() !== PROBLEM_JSON_CONTENT_TYPE) {
			continue;
		}
		const quality = params
			.map((param) => param.trim())
			.find((param) => param.toLowerCase().startsWith("q="));
		if (quality === undefined || Number(quality.slice(2)) > 0) {
			return true;
		}
	}
	return false;
}

/** A fresh server-generated request id: `req_<32 hex>`. */
export function newRequestId(): string {
	return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

const PRESENTED_BEARER = /^Bearer\s+\S+/i;

/**
 * The management listener's RFC 6750 challenge. A request that presented a
 * bearer token is told it was rejected (`invalid_token`); any other request,
 * including one with another scheme or an empty `Bearer`, carries no bearer
 * credential and gets the bare challenge (§3.1).
 */
export function managementChallenge(request: Request): string {
	return PRESENTED_BEARER.test(request.headers.get("authorization") ?? "")
		? `Bearer realm="${SITES_AUTH_REALM}", error="invalid_token"`
		: `Bearer realm="${SITES_AUTH_REALM}"`;
}

/** The legacy Sites error object. */
export interface SitesErrorObject {
	code: string;
	fields?: string[];
	message: string;
}

export interface ErrorResponseContext {
	/** Extra response headers, such as the rate-limit fields. */
	headers?: Readonly<Record<string, string>>;
	request: Request;
	/** Management responses carry a request id (header; problem body too). */
	requestId?: string;
}

function pathOf(request: Request): string | undefined {
	try {
		return new URL(request.url).pathname;
	} catch {
		return undefined;
	}
}

/**
 * The response for one Sites error: the legacy `{ error }` body, or, when the
 * request's Accept names `application/problem+json`, RFC 9457 problem details
 * that keep the same `error` member.
 */
export function errorResponse(
	error: SitesErrorObject,
	status: number,
	context: ErrorResponseContext
): Response {
	// The legacy body stays byte-for-byte what it always was; the request id
	// travels in `X-Request-ID` (and in the problem form below).
	const legacy: SitesErrorObject = { ...error };
	const headers = new Headers({
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		// The body's form depends on Accept (RFC 9110 §12.5.5).
		vary: "Accept",
	});
	for (const [name, value] of Object.entries(context.headers ?? {})) {
		headers.set(name, value);
	}
	if (context.requestId !== undefined) {
		headers.set(REQUEST_ID_HEADER, context.requestId);
	}
	if (!acceptsProblemJson(context.request.headers.get("accept"))) {
		return Response.json({ error: legacy }, { status, headers });
	}
	const instance = pathOf(context.request);
	headers.set("content-type", PROBLEM_JSON_CONTENT_TYPE);
	return new Response(
		JSON.stringify({
			type: SITES_PROBLEM_TYPE,
			title: statusTitle(status),
			status,
			detail: error.message,
			...(instance === undefined ? {} : { instance }),
			code: error.code,
			docs: SITES_PROBLEM_TYPE,
			...(context.requestId === undefined
				? {}
				: { requestId: context.requestId }),
			error: legacy,
		}),
		{ status, headers }
	);
}

/** A Sites error whose response carries extra headers. */
export class SiteErrorWithHeaders extends SiteError {
	constructor(
		code: string,
		message: string,
		status: number,
		readonly headers: Readonly<Record<string, string>>
	) {
		super(code, message, status);
	}
}

/**
 * Sets `headers` on `response`, copying it first when its headers are
 * immutable (for example `Response.redirect`).
 */
export function withHeaders(
	response: Response,
	headers: Readonly<Record<string, string>>
): Response {
	try {
		for (const [name, value] of Object.entries(headers)) {
			response.headers.set(name, value);
		}
		return response;
	} catch {
		const copy = new Headers(response.headers);
		for (const [name, value] of Object.entries(headers)) {
			copy.set(name, value);
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: copy,
		});
	}
}
