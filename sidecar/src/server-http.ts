/**
 * Request and response primitives shared by the Sites management and visitor
 * routes: JSON responses, the bounded JSON body reader, input schemas and the
 * mapping from a thrown error to a Sites error response.
 */
import { SidecarHostError } from "@ryu/sidecar-runtime";
import { isContentSealError } from "@ryu/sidecar-runtime/content";
import { SealUnavailableError } from "@ryu/sidecar-runtime/content-seal";
import { z } from "zod";
import type {
	RemixableSite,
	ResetActionResult,
	RuntimeSite,
} from "./contracts.ts";
import { type SiteDataValue, siteDataValueSchema } from "./data-values.ts";
import { errorResponse, SiteErrorWithHeaders } from "./http-conventions.ts";
import { SiteError } from "./store.ts";

export const json = (
	value:
		| SiteDataValue
		| RuntimeSite
		| RuntimeSite[]
		| RemixableSite[]
		| ResetActionResult,
	status = 200
) =>
	Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});

export const fail = (code: string, message: string, status = 400): never => {
	throw new SiteError(code, message, status);
};

// Bun before 1.4.4 ships an unpatched Brotli decoder (CVE-2026-111497,
// oven-sh/bun#46352). The satellite cannot import @ryu/portable-packages, so
// both listeners refuse a Brotli-encoded request body before anything reads it.
// Remove once the Bun image includes the fix.
const BROTLI_ENCODING = /\bbr\b/i;
export const rejectBrotliRequest = (request: Request): void => {
	const encoding = request.headers.get("content-encoding");
	if (encoding !== null && BROTLI_ENCODING.test(encoding)) {
		fail("unsupported_encoding", "Content-Encoding: br is not accepted", 415);
	}
};

/** The largest body a management route reads (`body()`'s default limit). */
const MAX_ROUTE_BODY_BYTES = 2_100_000;
/** The management listener's own cap, kept above every route limit. */
export const ADMIN_MAX_REQUEST_BODY_BYTES = 2_200_000;
/** The visitor listener's cap, above its largest route limit (uploads). */
export const VISITOR_MAX_REQUEST_BODY_BYTES = 7_000_000;

export async function body(
	request: Request,
	limit = MAX_ROUTE_BODY_BYTES
): Promise<SiteDataValue> {
	if (!request.headers.get("content-type")?.includes("application/json")) {
		fail("invalid_input", "JSON body required", 415);
	}
	const reader = request.body?.getReader();
	if (!reader) {
		return fail("invalid_input", "Body required");
	}
	let size = 0;
	const chunks: Uint8Array[] = [];
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		size += chunk.value.byteLength;
		if (size > limit) {
			await reader.cancel();
			fail("too_large", "Request exceeds the size limit", 413);
		}
		chunks.push(chunk.value);
	}
	try {
		return siteDataValueSchema.parse(
			JSON.parse(
				await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).text()
			)
		);
	} catch {
		return fail("invalid_input", "Invalid JSON");
	}
}

export const normalizeHost = (host: string) =>
	host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

export const domainInput = z
	.string()
	.max(253)
	.regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);

export const revisionInput = z.object({
	expectedRevision: z.number().int().nonnegative(),
});

/** Where an error response goes; management responses carry a request id. */
export interface ErrorContext {
	request: Request;
	requestId?: string;
}

/**
 * The Sites error response for a thrown `error`, negotiated for
 * `context.request` (see `./http-conventions.ts`). Unknown errors never leak
 * their message.
 */
export function siteErrorResponse(
	error: unknown,
	context: ErrorContext
): Response {
	const failWith = (
		value: { code: string; fields?: string[]; message: string },
		status: number,
		headers?: Readonly<Record<string, string>>
	) =>
		errorResponse(value, status, {
			request: context.request,
			...(context.requestId === undefined
				? {}
				: { requestId: context.requestId }),
			...(headers === undefined ? {} : { headers }),
		});
	if (error instanceof SidecarHostError) {
		const denied = error.status === 401 || error.status === 403;
		const invalidInput = error.status === 400;
		return failWith(
			{
				code: denied
					? "platform_permission_required"
					: invalidInput
						? "invalid_input"
						: "platform_unavailable",
				message: error.message,
			},
			denied ? 403 : invalidInput ? 400 : 503
		);
	}
	if (error instanceof SiteError) {
		return failWith(
			{ code: error.code, message: error.message },
			error.status,
			error instanceof SiteErrorWithHeaders ? error.headers : undefined
		);
	}
	if (error instanceof SealUnavailableError) {
		return failWith(
			{ code: "sealing_unavailable", message: error.message },
			503
		);
	}
	if (isContentSealError(error)) {
		const refused = error.code === "already_a_ryu_envelope";
		return failWith(
			{
				code: refused ? "invalid_input" : "data_unreadable",
				message: refused
					? "This file cannot be stored"
					: "This stored item cannot be read",
			},
			refused ? 400 : 503
		);
	}
	if (error instanceof z.ZodError) {
		return failWith(
			{
				code: "invalid_input",
				message: "Check the submitted fields",
				fields: error.issues.map((issue) => issue.path.join(".")),
			},
			400
		);
	}
	return failWith(
		{
			code: "internal_error",
			message: "The operation could not be completed",
		},
		500
	);
}
