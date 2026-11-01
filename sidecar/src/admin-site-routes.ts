/**
 * Management routes under `/projects/:siteId`: the shared permission chain
 * and the actions open to visitors, editors and the owner's extension
 * settings. Owner-only settings live in `./admin-owner-routes.ts`.
 *
 * The permission chain is the one the former single handler applied, in the
 * same order: remix first, then visit, a per-action check, edit (saved
 * versions stay readable), and owner. A request whose own check fails keeps
 * walking the chain, so it gets the same 403 or 404 as before.
 */
import type { RouteMethod } from "@ryu/sidecar-runtime/effect-http";
import { z } from "zod";
import {
	artifactProblem,
	canEdit,
	isOwner,
	ownerConnectionsInput,
	type RuntimeSite,
	SITE_LIMITS,
	type SitePrincipal,
	saveVersionInput,
	siteOrigin,
} from "./contracts.ts";
import { deployedExtensions, sitePlugin } from "./extension-routes.ts";
import { siteExtensions } from "./extensions.ts";
import {
	applyOwnerConnections,
	ownerConnectionAllowed,
	ownerConnectionPublicId,
	ownerConnectionReadOnly,
	readOwnerConnectionPolicy,
} from "./owner-connections.ts";
import { auditConnectionChange } from "./server-audit.ts";
import type { SitesContext } from "./server-context.ts";
import { body, fail, json, revisionInput } from "./server-http.ts";
import { inspectSiteSecurity } from "./site-security.ts";

/** An authenticated management request. */
export interface AdminCall {
	/** The path without its optional `/api/sites` prefix. */
	path: string;
	request: Request;
	url: URL;
	user: SitePrincipal;
}

/** A management request addressed to one Site. */
export interface SiteCall extends AdminCall {
	/** Everything after `/projects/:siteId/` (empty for the Site itself). */
	action: string;
	site: RuntimeSite;
}

/** The last check a Site action needs before it runs. */
export type SiteLevel = "remix" | "visit" | "edit" | "owner";

export interface SiteAction {
	/** Its own check at the `visit` level; a failure walks on down the chain. */
	allowed?: (context: SitesContext, call: SiteCall) => boolean;
	level: SiteLevel;
	matches: (action: string) => boolean;
	method: Exclude<RouteMethod, "*">;
	/** The router path after `/projects/:siteId`. */
	route: string;
	serve: (context: SitesContext, call: SiteCall) => Promise<Response>;
}

export const SITE_PATH = /^\/projects\/([^/]+)(?:\/(.*))?$/;

export const named = (name: string) => (action: string) => action === name;

/**
 * Runs a Site action behind the permission chain, or (with no action) walks
 * the whole chain to the 404 every unknown operation gets.
 */
export async function serveSiteAction(
	context: SitesContext,
	call: AdminCall,
	siteId: string,
	action: string,
	endpoint: SiteAction | undefined
): Promise<Response> {
	const { request, user } = call;
	const site = context.store.get(siteId);
	const siteCall: SiteCall = { ...call, site, action };
	if (endpoint?.level === "remix") {
		return await endpoint.serve(context, siteCall);
	}
	if (!context.visitAllowed(site, user)) {
		return fail("forbidden", "You cannot access this Site", 403);
	}
	if (
		endpoint?.level === "visit" &&
		(endpoint.allowed?.(context, siteCall) ?? true)
	) {
		return await endpoint.serve(context, siteCall);
	}
	const readOnlyVersion =
		action.startsWith("versions/") && request.method === "GET";
	if (!(canEdit(site, user) || readOnlyVersion)) {
		return fail("forbidden", "You cannot edit this Site", 403);
	}
	if (endpoint?.level === "edit") {
		return await endpoint.serve(context, siteCall);
	}
	if (!isOwner(site, user)) {
		return fail(
			"forbidden",
			"Only the Site owner can manage these settings",
			403
		);
	}
	if (endpoint?.level === "owner") {
		return await endpoint.serve(context, siteCall);
	}
	return fail("not_found", "Operation not found", 404);
}

const owner = (_context: SitesContext, { site, user }: SiteCall) =>
	isOwner(site, user);
const editor = (_context: SitesContext, { site, user }: SiteCall) =>
	canEdit(site, user);

async function installPlugin(context: SitesContext, call: SiteCall) {
	const { site, request } = call;
	const input = revisionInput
		.extend({ update: z.boolean().default(false) })
		.strict()
		.parse(await body(request, 1000));
	if (input.expectedRevision !== site.revision) {
		return fail("conflict", "Reload before installing the plugin", 409);
	}
	if (!(site.deploymentId && deployedExtensions(site).mcp)) {
		return fail(
			"unavailable",
			"Publish MCP tools before installing the plugin",
			409
		);
	}
	if (!context.services.installPlugin) {
		return fail("unavailable", "Plugin installation is unavailable", 503);
	}
	const origin = siteOrigin(
		site.slug,
		context.baseDomain,
		context.visitorPort()
	);
	return json(
		await context.services.installPlugin(
			{ ...sitePlugin(site, origin), update: input.update },
			request
		)
	);
}

async function saveExtensions(context: SitesContext, call: SiteCall) {
	const { services, options, store } = context;
	const { site } = call;
	const input = revisionInput
		.extend({ extensions: siteExtensions })
		.strict()
		.parse(await body(call.request, 32_000));
	if (
		input.extensions.mcp &&
		!(services.mcpIdentity && services.authorizationServer)
	) {
		return fail(
			"unavailable",
			"Configure platform MCP authentication before enabling tools",
			503
		);
	}
	if (input.extensions.ui && !options.visitorScript) {
		return fail("unavailable", "The Site UI runtime is unavailable", 503);
	}
	const approved = services.connections?.(site.id) ?? [];
	if (
		input.extensions.connections.some(
			(id) => !approved.some((connection) => connection.id === id)
		)
	) {
		return fail("forbidden", "Choose an operator-approved connection", 403);
	}
	if (input.extensions.connections.length && !services.invokeConnection) {
		return fail("unavailable", "Connected tools are unavailable", 503);
	}
	return json(
		store.mutate(site.id, input.expectedRevision, (current) => {
			current.settings.extensions = input.extensions;
		})
	);
}

function listConnections(context: SitesContext, { site }: SiteCall) {
	const { services } = context;
	const policy = readOwnerConnectionPolicy(services.ownerConnectionPolicy);
	return json({
		available: Boolean(services.invokeConnection),
		policy: {
			enabled: policy.enabled,
			tools: policy.tools ? [...policy.tools] : null,
			agents: [...policy.agents],
			readOnlyTools: [...policy.readOnlyTools],
		},
		connections: (site.connections ?? []).map((connection) => ({
			...connection,
			publicId: ownerConnectionPublicId(connection.id),
			allowed: ownerConnectionAllowed(policy, connection),
			effectiveReadOnly: ownerConnectionReadOnly(policy, connection),
		})),
		operator: (services.connections?.(site.id) ?? []).map((connection) => ({
			id: connection.id,
			label: connection.label,
			readOnly: connection.readOnly,
			selected: site.settings.extensions.connections.includes(connection.id),
		})),
	});
}

async function saveConnections(context: SitesContext, call: SiteCall) {
	const { services, store } = context;
	const { site, user } = call;
	const input = ownerConnectionsInput.parse(await body(call.request, 32_000));
	if (!services.invokeConnection) {
		return fail("unavailable", "Connected tools are unavailable", 503);
	}
	const policy = readOwnerConnectionPolicy(services.ownerConnectionPolicy);
	const operatorIds = new Set(
		(services.connections?.(site.id) ?? []).map((connection) => connection.id)
	);
	if (
		input.connections.some((entry) =>
			operatorIds.has(ownerConnectionPublicId(entry.id))
		)
	) {
		return fail("conflict", "An operator connection already uses this ID", 409);
	}
	const saved = store.mutate(site.id, input.expectedRevision, (current) => {
		const changes = applyOwnerConnections({
			current: current.connections ?? [],
			requested: input.connections,
			policy,
			actor: user.id,
			now: new Date().toISOString(),
		});
		current.connections = changes.next;
		// A changed or removed binding keeps no stale consent.
		const forget = store.db.query(
			"DELETE FROM connection_consents WHERE site=? AND connection=?"
		);
		for (const id of [...changes.changed, ...changes.removed]) {
			forget.run(site.id, ownerConnectionPublicId(id));
		}
		auditConnectionChange(store, site.id, user.id, {
			added: changes.added,
			changed: changes.changed,
			removed: changes.removed,
			revision: current.revision + 1,
		});
	});
	return json(context.presentSite(saved, user));
}

async function saveVersion(context: SitesContext, call: SiteCall) {
	const { store } = context;
	const input = saveVersionInput.parse(await body(call.request));
	const bytes = new TextEncoder().encode(input.html).length;
	const problem = artifactProblem(input.html);
	if (problem) {
		return fail(problem.code, problem.message, problem.status);
	}
	const saved = store.mutate(
		call.site.id,
		input.expectedRevision,
		(current) => {
			if (
				current.versions.length >= SITE_LIMITS.versions ||
				current.versions.reduce((sum, version) => sum + version.bytes, 0) +
					bytes >
					SITE_LIMITS.totalArtifactBytes
			) {
				fail("quota", "Saved version storage limit reached", 429);
			}
			const id = crypto.randomUUID();
			store.db
				.query("INSERT INTO artifacts VALUES(?,?,?)")
				.run(call.site.id, id, input.html);
			current.versions.push({
				extensions: structuredClone(current.settings.extensions),
				id,
				bytes,
				message: input.message,
				commit: input.commit,
				createdAt: new Date().toISOString(),
			});
		}
	);
	return json(saved, 201);
}

async function deploy(context: SitesContext, call: SiteCall) {
	const { site, user } = call;
	const input = revisionInput
		.extend({ versionId: z.string() })
		.strict()
		.parse(await body(call.request));
	if (!(site.hasPublished || isOwner(site, user))) {
		return fail("forbidden", "The owner must deploy the first version", 403);
	}
	const report = await inspectSiteSecurity(
		site,
		input.versionId,
		context.store,
		context.services
	);
	if (report.status !== "passed") {
		return fail("security_blocked", report.summary, 422);
	}
	return json(
		context.store.mutate(site.id, input.expectedRevision, (current) => {
			current.deploymentId = input.versionId;
			current.hasPublished = true;
		})
	);
}

/** Site actions up to the owner check, in the former handler's order. */
export const SITE_ACTIONS: readonly SiteAction[] = [
	{
		method: "POST",
		route: "/remix",
		matches: named("remix"),
		level: "remix",
		serve: (context, { site, user, request }) =>
			context.remix(site, user, request),
	},
	{
		method: "POST",
		route: "/install-plugin",
		matches: named("install-plugin"),
		level: "visit",
		allowed: owner,
		serve: installPlugin,
	},
	{
		method: "GET",
		route: "/extensions",
		matches: named("extensions"),
		level: "visit",
		allowed: editor,
		serve: async (context, { site }) =>
			json({
				connections: context.services.connections?.(site.id) ?? [],
				published: deployedExtensions(site),
				plugin: sitePlugin(
					site,
					siteOrigin(site.slug, context.baseDomain, context.visitorPort())
				),
			}),
	},
	{
		method: "PUT",
		route: "/extensions",
		matches: named("extensions"),
		level: "visit",
		allowed: owner,
		serve: saveExtensions,
	},
	{
		method: "GET",
		route: "/connections",
		matches: named("connections"),
		level: "visit",
		allowed: editor,
		serve: async (context, call) => listConnections(context, call),
	},
	{
		method: "PUT",
		route: "/connections",
		matches: named("connections"),
		level: "visit",
		allowed: editor,
		serve: saveConnections,
	},
	{
		method: "GET",
		route: "",
		matches: named(""),
		level: "visit",
		serve: async (context, { site, user }) =>
			json(context.presentSite(site, user)),
	},
	{
		method: "GET",
		route: "/security",
		matches: named("security"),
		level: "edit",
		serve: async (context, { site, url }) => {
			const versionId =
				url.searchParams.get("versionId") ?? site.versions.at(-1)?.id;
			if (!versionId) {
				return fail("not_found", "Save a version before checking it", 404);
			}
			return json(
				await inspectSiteSecurity(
					site,
					versionId,
					context.store,
					context.services
				)
			);
		},
	},
	{
		method: "GET",
		route: "/versions/*",
		matches: (action) => action.startsWith("versions/"),
		level: "edit",
		serve: async (context, { site, action }) =>
			json({ html: context.store.artifact(site.id, action.slice(9)) }),
	},
	{
		method: "POST",
		route: "/versions",
		matches: named("versions"),
		level: "edit",
		serve: saveVersion,
	},
	{
		method: "POST",
		route: "/deploy",
		matches: named("deploy"),
		level: "edit",
		serve: deploy,
	},
];
