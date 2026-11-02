/**
 * The checks every visitor request passes before a page or `/_ryu/` endpoint
 * serves it, in the order the visitor listener always applied them: Site
 * resolution by host, the rate limit, platform sign-in, the Site's MCP
 * endpoint, visit permission, alias redirects and the origin check.
 */
import { bunServerOf } from "@ryu/sidecar-runtime/effect-http";
import { visitorClientAddress } from "./client-address.ts";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import { EDGE_READY_PATH } from "./edge-readiness.ts";
import { deployedExtensions, handleSiteMcp } from "./extension-routes.ts";
import type { SitesContext } from "./server-context.ts";
import {
	body,
	fail,
	json,
	normalizeHost,
	rejectBrotliRequest,
} from "./server-http.ts";
import { visitorData } from "./visitor-data.ts";
import { privateSitePage } from "./visitor-pages.ts";

/** A visitor request with its public URL and host. */
export interface VisitorRequest {
	host: string;
	/** The request as accepted, for the client address and Bun timeouts. */
	incoming: Request;
	/** The request under its public URL (`https` behind a managed edge). */
	request: Request;
	url: URL;
}

/** A visitor request addressed to a deployed Site. */
export interface SiteVisit extends VisitorRequest {
	ip: string;
	/** The Site selected by ID on loopback MCP discovery paths. */
	localMcpSite: string | undefined;
	site: RuntimeSite & { deploymentId: string };
}

/** A visit that passed every Site-level check. */
export interface VisitorCall extends SiteVisit {
	user: SitePrincipal | null;
}

const isDeployed = (
	site: RuntimeSite
): site is RuntimeSite & { deploymentId: string } => Boolean(site.deploymentId);

const LOCAL_MCP_PATH =
	/^\/(?:sites|\.well-known\/oauth-protected-resource\/sites)\/([^/]+)\/mcp$/;

/** The visitor's address: the socket peer, or a trusted proxy's forward. */
export function clientAddress(context: SitesContext, incoming: Request) {
	return visitorClientAddress(
		bunServerOf(incoming)?.requestIP(incoming)?.address ?? "unknown",
		incoming.headers,
		context.trustedProxies
	);
}

/** Refuses Brotli bodies and moves the request onto its public URL. */
export function visitorRequest(
	context: SitesContext,
	incoming: Request
): VisitorRequest {
	rejectBrotliRequest(incoming);
	const url = new URL(incoming.url);
	// Public deployments terminate TLS at their managed edge. The scheme
	// comes from trusted deployment configuration, never a forwarded header.
	if (context.baseDomain !== "localhost") {
		url.protocol = "https:";
		url.port = "";
	}
	const request =
		url.href === incoming.url ? incoming : new Request(url, incoming);
	const host = normalizeHost(request.headers.get("host") ?? "");
	return { host, incoming, request, url };
}

/**
 * The edge readiness probe reaches a custom domain before it is active. It
 * confirms only that this service has the domain bound; it serves no Site
 * content.
 */
export function isEdgeReadyProbe({ url, request }: VisitorRequest) {
	return url.pathname === EDGE_READY_PATH && request.method === "GET";
}

export function edgeReady(context: SitesContext, visit: VisitorRequest) {
	const bound = context.store
		.list()
		.find((candidate) =>
			candidate.domains.some((domain) => domain.host === visit.host)
		);
	if (!bound) {
		return fail("not_found", "Domain is not bound to a Site", 404);
	}
	context.admitVisitor(bound.id, clientAddress(context, visit.incoming));
	return json({ ready: true, host: visit.host });
}

/**
 * Finds the deployed Site the host names, counts the request against its
 * rate limit, and lets platform sign-in answer its own paths.
 */
export async function resolveVisit(
	context: SitesContext,
	visit: VisitorRequest
): Promise<SiteVisit | Response> {
	const { baseDomain, store, services } = context;
	const { host, url, request } = visit;
	const localMcpSite =
		baseDomain === "localhost" && ["127.0.0.1", "localhost"].includes(host)
			? LOCAL_MCP_PATH.exec(url.pathname)?.[1]
			: undefined;
	const site = store
		.list()
		.find(
			(candidate) =>
				candidate.id === localMcpSite ||
				host === `${candidate.slug}.${baseDomain}` ||
				candidate.aliases.some((alias) => host === `${alias}.${baseDomain}`) ||
				candidate.domains.some(
					(domain) => domain.host === host && domain.status === "active"
				)
		);
	if (!(site && isDeployed(site))) {
		return fail("not_found", "Site is not deployed", 404);
	}
	const ip = clientAddress(context, visit.incoming);
	context.admitVisitor(site.id, ip);
	const authResponse = await services.signIn?.(request);
	if (authResponse) {
		return authResponse;
	}
	return { ...visit, ip, localMcpSite, site };
}

/**
 * Serves the Site's MCP endpoint and its protected-resource metadata. Site
 * hosts use `/mcp`; loopback discovery uses `/sites/:id/mcp`. Returns null
 * when the request is not for either.
 */
export async function serveSiteMcp(
	context: SitesContext,
	visit: SiteVisit
): Promise<Response | null> {
	const { services, store, options } = context;
	const { localMcpSite, request, site, url } = visit;
	const resourceMetadataPath = localMcpSite
		? `/.well-known/oauth-protected-resource/sites/${site.id}/mcp`
		: "/.well-known/oauth-protected-resource";
	const mcpPath = localMcpSite ? `/sites/${site.id}/mcp` : "/mcp";
	if (
		url.pathname === resourceMetadataPath &&
		request.method === "GET" &&
		services.authorizationServer &&
		deployedExtensions(site).mcp
	) {
		return json({
			resource: `${url.origin}${mcpPath}`,
			authorization_servers: [services.authorizationServer],
			bearer_methods_supported: ["header"],
		});
	}
	if (url.pathname !== mcpPath) {
		return null;
	}
	if (
		request.headers.has("origin") &&
		request.headers.get("origin") !== url.origin
	) {
		return fail("origin_denied", "MCP request origin denied", 403);
	}
	const principal = await services.mcpIdentity?.(request);
	if (!principal) {
		return new Response(null, {
			status: 401,
			headers: {
				"cache-control": "no-store",
				"www-authenticate": `Bearer resource_metadata="${url.origin}${resourceMetadataPath}"`,
			},
		});
	}
	if (!context.visitAllowed(site, principal)) {
		return fail("forbidden", "You cannot access this Site", 403);
	}
	if (request.method !== "POST") {
		return new Response(null, { status: 405, headers: { allow: "POST" } });
	}
	return handleSiteMcp({
		request,
		site,
		user: principal,
		services,
		html: store.artifact(site.id, site.deploymentId),
		visitorScript: options.visitorScript ?? "",
		body: await body(request, 64_000),
		data: (operation, operationUrl) =>
			visitorData(
				operation,
				operationUrl,
				site,
				principal,
				store,
				services,
				`user:${principal.id}`
			),
	});
}

/**
 * Applies the visitor's identity to the Site's audience, redirects old
 * aliases, and refuses cross-origin mutations.
 */
export async function authorizeVisit(
	context: SitesContext,
	visit: SiteVisit
): Promise<VisitorCall | Response> {
	const { baseDomain, services } = context;
	const { localMcpSite, request, site, url, host } = visit;
	// Loopback selection by Site ID exists only for local MCP discovery.
	// Serving pages there would put every Site on one shared origin.
	if (localMcpSite) {
		return fail("not_found", "Site is not deployed", 404);
	}
	const user = (await services.identity?.(request)) ?? null;
	if (!context.visitAllowed(site, user)) {
		if (request.method === "GET" && !url.pathname.startsWith("/_ryu/")) {
			const page = privateSitePage(
				request.headers.get("accept-language"),
				Boolean(services.signIn)
			);
			return new Response(page, {
				status: 403,
				headers: {
					"content-type": "text/html; charset=utf-8",
					vary: "accept-language",
					"cache-control": "no-store",
					"content-security-policy":
						"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
				},
			});
		}
		return fail(
			"forbidden",
			"Sign in with an account that has access to this Site",
			403
		);
	}
	if (site.aliases.some((alias) => host === `${alias}.${baseDomain}`)) {
		url.hostname = `${site.slug}.${baseDomain}`;
		return Response.redirect(url.toString(), 308);
	}
	if (
		!["GET", "HEAD"].includes(request.method) &&
		request.headers.get("origin") !== url.origin
	) {
		return fail("origin_denied", "Request origin does not match the Site", 403);
	}
	return { ...visit, user };
}
