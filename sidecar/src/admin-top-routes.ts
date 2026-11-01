/**
 * Authenticated management endpoints outside a single Site: the visitor
 * runtime, the service status, and the Site list and create routes.
 */
import type { RouteMethod } from "@ryu/sidecar-runtime/effect-http";
import { Effect } from "effect";
import type { AdminCall } from "./admin-site-routes.ts";
import {
	canEdit,
	isOwner,
	type RemixableSite,
	SITE_LIMITS,
} from "./contracts.ts";
import { attempt, type Endpoint } from "./effect-routes.ts";
import { readOwnerConnectionPolicy } from "./owner-connections.ts";
import type { SitesContext } from "./server-context.ts";
import { body, fail, json } from "./server-http.ts";
import { SITES_API_VERSION } from "./service-info.ts";

/** An authenticated endpoint; `matches` is exact on path and method. */
export interface AdminEndpoint {
	matches: (path: string, request: Request) => boolean;
	method: Exclude<RouteMethod, "*">;
	/** The router path, served with and without `/api/sites`. */
	path: `/${string}`;
	serve: (context: SitesContext, call: AdminCall) => Endpoint;
}

const at =
	(pathname: string, method: string) => (path: string, request: Request) =>
		path === pathname && request.method === method;

function status(context: SitesContext) {
	const { services, options, store, standalone } = context;
	return json({
		apiVersion: SITES_API_VERSION,
		limits: SITE_LIMITS,
		sealing: { ...store.seal.health() },
		mode: standalone ? "standalone" : "core",
		publicEnabled: options.publicEnabled === true,
		identityAvailable: Boolean(services.identity),
		retrievalAvailable: Boolean(services.retrieve),
		answersAvailable: Boolean(services.answer),
		completionsAvailable: Boolean(services.complete),
		databaseAvailable: Boolean(services.spacesDatabase),
		agentAvailable: Boolean(services.runResetAction),
		scannerAvailable: Boolean(services.scanArtifact),
		connectionsAvailable: Boolean(services.invokeConnection),
		ownerConnectionsAvailable:
			Boolean(services.invokeConnection) &&
			readOwnerConnectionPolicy(services.ownerConnectionPolicy).enabled,
		// No edge/TLS provider ships with the local runtime. Domains go live
		// only when the operator configures an edge readiness URL; without one
		// a verified domain stays pending_tls.
		domainsAvailable: Boolean(services.domainReady),
		mcpAvailable: Boolean(services.mcpIdentity && services.authorizationServer),
		pluginInstallAvailable: Boolean(services.installPlugin),
		mcpUiAvailable: Boolean(options.visitorScript),
		visitorPort: context.visitorPort(),
		baseDomain: context.baseDomain,
	});
}

function listSites(context: SitesContext, { url, user }: AdminCall) {
	const { store, visitAllowed, presentSite } = context;
	const scope = url.searchParams.get("scope") ?? "owned";
	if (scope === "remixable") {
		// A gallery card, never the full record: access lists, domains and
		// connections stay with the Site.
		return json(
			store.list().flatMap((site): RemixableSite[] =>
				site.deploymentId &&
				site.settings.allowRemix &&
				!isOwner(site, user) &&
				visitAllowed(site, user)
					? [
							{
								id: site.id,
								name: site.name,
								slug: site.slug,
								template: site.template,
								deploymentId: site.deploymentId,
								updatedAt: site.updatedAt,
								access: canEdit(site, user) ? "editor" : "viewer",
							},
						]
					: []
			)
		);
	}
	const visible = store
		.list()
		.filter((site) =>
			scope === "owned"
				? isOwner(site, user)
				: scope === "shared"
					? !isOwner(site, user) && visitAllowed(site, user)
					: false
		);
	if (scope !== "owned" && scope !== "shared") {
		return fail("invalid_input", "Choose owned, shared or remixable Sites");
	}
	return json(visible.map((site) => presentSite(site, user)));
}

/** In the order the former handler tried them. */
export const ADMIN_ENDPOINTS: readonly AdminEndpoint[] = [
	{
		method: "GET",
		path: "/runtime",
		matches: at("/runtime", "GET"),
		serve: ({ options }) =>
			Effect.sync(() => json({ script: options.visitorScript ?? "" })),
	},
	{
		method: "GET",
		path: "/status",
		matches: at("/status", "GET"),
		serve: (context) => Effect.sync(() => status(context)),
	},
	{
		method: "GET",
		path: "/projects",
		matches: at("/projects", "GET"),
		serve: (context, call) => attempt(() => listSites(context, call)),
	},
	{
		method: "POST",
		path: "/projects",
		matches: at("/projects", "POST"),
		serve: ({ store }, { request, user }) =>
			attempt(async () =>
				json(
					{ ...store.create(await body(request), user), access: "owner" },
					201
				)
			),
	},
];
