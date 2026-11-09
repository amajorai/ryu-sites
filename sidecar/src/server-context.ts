/**
 * Per-server state shared by the management and visitor routes: the store,
 * services, operator policy, rate limiting, the shared-records hub, and the
 * access helpers every route applies.
 */
import { parseTrustedProxies } from "./client-address.ts";
import {
	canEdit,
	canVisit,
	isOwner,
	type RuntimeSite,
	remixSiteInput,
	type SitePrincipal,
} from "./contracts.ts";
import { createConnectionConsent } from "./extension-routes.ts";
import { SiteErrorWithHeaders } from "./http-conventions.ts";
import { createVisitorRateLimiter, rateLimitHeaders } from "./rate-limit.ts";
import { REMIX_AUDIT_ACTION } from "./server-audit.ts";
import { body, fail, json } from "./server-http.ts";
import { type IdentityPurpose, identityRequired } from "./server-messages.ts";
import type { ServerOptions } from "./server-types.ts";
import { createSharedRecordsHub } from "./shared-records.ts";

export type SitesContext = ReturnType<typeof createSitesContext>;

/**
 * Builds the shared state for one Sites server. `visitorPort` reads the bound
 * visitor port once the listener is up (it can be an ephemeral port).
 */
export function createSitesContext(
	options: ServerOptions,
	visitorPort: () => number
) {
	const { store } = options;
	const services = options.services ?? {};
	const standalone = options.mode === "standalone";
	const owner: SitePrincipal = {
		id: options.ownerId ?? "node-owner",
		email: "",
		workspaceIds: [],
	};
	const rateLimiter = createVisitorRateLimiter();
	// The operator's public-publishing switch applies on every request: when it
	// is off, Sites saved as public are served as owner-only until it returns
	// or the owner chooses another audience.
	const visitAllowed = (site: RuntimeSite, user: SitePrincipal | null) =>
		canVisit(
			site.settings.audience === "public" && options.publicEnabled !== true
				? { ...site, settings: { ...site.settings, audience: "private" } }
				: site,
			user
		);
	// Owner-only AI instructions never leave the sidecar for editors or viewers.
	const presentSite = (site: RuntimeSite, user: SitePrincipal | null) => {
		const access: RuntimeSite["access"] = isOwner(site, user)
			? "owner"
			: canEdit(site, user)
				? "editor"
				: "viewer";
		return {
			...site,
			access,
			settings:
				access === "owner"
					? site.settings
					: { ...site.settings, aiSystemPrompt: "" },
		} satisfies RuntimeSite;
	};
	/**
	 * Starts a new private Site for `user` from `source`. Owners and editors
	 * copy the latest saved version; anyone else may copy only the deployed
	 * version, and only when the owner allows remixing. A Site the caller
	 * cannot visit answers as missing, so remixing never reveals one.
	 */
	const remix = async (
		source: RuntimeSite,
		user: SitePrincipal,
		request: Request
	): Promise<Response> => {
		if (!visitAllowed(source, user)) {
			return fail("not_found", "Site not found", 404);
		}
		const editor = canEdit(source, user);
		if (!(editor || source.settings.allowRemix)) {
			return fail(
				"forbidden",
				"The owner has not allowed remixing this Site",
				403
			);
		}
		const input = remixSiteInput.parse(await body(request, 1000));
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== source.revision
		) {
			return fail("conflict", "Site changed. Reload before remixing.", 409);
		}
		const versionId = editor
			? source.versions.at(-1)?.id
			: (source.deploymentId ?? undefined);
		if (!versionId) {
			return fail(
				"unavailable",
				editor
					? "Save a version before duplicating this Site"
					: "This Site has no deployed version to remix",
				409
			);
		}
		const created = store.remix(source, versionId, input, user);
		store.db.query("INSERT INTO site_audit VALUES(?,?,?,?,?,?)").run(
			created.id,
			created.createdAt,
			user.id,
			REMIX_AUDIT_ACTION,
			source.id,
			JSON.stringify({
				// Owners and editors copy the latest saved version: a duplicate.
				kind: editor ? "duplicate" : "remix",
				sourceVersionId: versionId,
			})
		);
		return json(presentSite(created, user), 201);
	};
	return {
		options,
		store,
		services,
		standalone,
		owner,
		consent: createConnectionConsent(),
		baseDomain: options.baseDomain ?? "localhost",
		databaseLabel: standalone ? "the Site database" : "a Ryu Spaces database",
		// Page-view analytics only. A per-process salt keeps those digests from
		// linking a visitor across restarts; usage counters use the store's
		// persisted key instead, so a restart never resets a visitor's share.
		trafficSalt: crypto.randomUUID(),
		trustedProxies: parseTrustedProxies(options.trustedProxies ?? []),
		sharedHub: createSharedRecordsHub(),
		visitorPort,
		visitAllowed,
		presentSite,
		remix,
		// Core connects platform identity itself; a standalone operator sets
		// the process's OpenID Connect client instead, so name those settings.
		identityRequired: (purpose: IdentityPurpose): never =>
			identityRequired(standalone, purpose),
		/** Counts one visitor request, or refuses it with the rate-limit fields. */
		admitVisitor: (siteId: string, address: string) => {
			const decision = rateLimiter.check(siteId, address);
			if (!decision.allowed) {
				throw new SiteErrorWithHeaders(
					"rate_limit",
					"Too many requests; retry shortly",
					429,
					rateLimitHeaders(decision, rateLimiter.policies)
				);
			}
		},
	};
}
