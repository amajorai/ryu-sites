/**
 * Visitor routes for a Site's connected tools: the consent review page
 * (`/_ryu/connections/consent`) and the list, revoke, and invoke calls
 * (`/_ryu/connections`). Split from `extension-routes.ts`, which re-exports
 * them.
 */
import { z } from "zod";
import {
	type RuntimeSite,
	SITE_LIMITS,
	type SitePrincipal,
} from "./contracts.ts";
import { type SiteDataValue, siteDataRecordSchema } from "./data-values.ts";
import { siteConnections } from "./extension-routes.ts";
import type { SitesServices } from "./server.ts";
import { SiteError, type SitesStore } from "./store.ts";
import { connectionConsentPage } from "./visitor-pages.ts";

const json = (value: SiteDataValue) =>
	Response.json(value, {
		headers: {
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});

export interface ConnectionRequest {
	body: () => Promise<SiteDataValue>;
	request: Request;
	services: SitesServices;
	site: RuntimeSite;
	store: SitesStore;
	user: SitePrincipal | null;
}
export function createConnectionConsent() {
	const tickets = new Map<
		string,
		{
			userId: string;
			siteId: string;
			connectionId: string;
			revision: string;
			expires: number;
		}
	>();
	return async (input: ConnectionRequest) => {
		const { request, site, user, services, store } = input;
		assertConnectionAccess(site, user);
		if (!user) {
			throw new SiteError("unauthorized", "Sign in to review connections", 401);
		}
		// Only a user-activated top-level navigation can open the trusted consent UI.
		// Generated Site JavaScript cannot fetch this page and auto-approve itself.
		if (
			request.headers.get("sec-fetch-mode") !== "navigate" ||
			request.headers.get("sec-fetch-dest") !== "document" ||
			request.headers.get("sec-fetch-user") !== "?1"
		) {
			throw new SiteError(
				"consent_required",
				"Open connection permissions from a user action",
				403
			);
		}
		for (const [id, ticket] of tickets) {
			if (ticket.expires <= Date.now()) {
				tickets.delete(id);
			}
		}
		const url = new URL(request.url);
		if (request.method === "POST") {
			const text = await request.text();
			if (text.length > 4000) {
				throw new SiteError("too_large", "Consent request is too large", 413);
			}
			const parameters = new URLSearchParams(text);
			const id = parameters.get("ticket") ?? "";
			const ticket = tickets.get(id);
			tickets.delete(id);
			if (
				!ticket ||
				ticket.userId !== user.id ||
				ticket.siteId !== site.id ||
				ticket.expires <= Date.now()
			) {
				throw new SiteError(
					"consent_required",
					"Connection review expired. Open it again.",
					403
				);
			}
			const connection = siteConnections(site, services).find(
				(item) => item.id === ticket.connectionId
			);
			if (!connection || connection.revision !== ticket.revision) {
				throw new SiteError("conflict", "Connection permissions changed", 409);
			}
			if (parameters.get("decision") === "allow") {
				store.db
					.query("INSERT OR REPLACE INTO connection_consents VALUES(?,?,?,?)")
					.run(site.id, user.id, connection.id, ticket.revision);
			}
			return new Response(null, {
				status: 303,
				headers: { location: "/", "cache-control": "no-store" },
			});
		}
		const connection = siteConnections(site, services).find(
			(item) => item.id === url.searchParams.get("connectionId")
		);
		if (!connection) {
			throw new SiteError(
				"tool_not_allowed",
				"Connection is not available",
				403
			);
		}
		if (tickets.size >= 1000) {
			throw new SiteError("rate_limit", "Too many connection reviews", 429);
		}
		const id = crypto.randomUUID();
		tickets.set(id, {
			userId: user.id,
			siteId: site.id,
			connectionId: connection.id,
			revision: connection.revision,
			expires: Date.now() + 300_000,
		});
		return new Response(
			connectionConsentPage({
				acceptLanguage: request.headers.get("accept-language"),
				connection,
				site,
				user,
				ticket: id,
			}),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "private, no-store",
					"content-security-policy":
						"default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
					"x-content-type-options": "nosniff",
				},
			}
		);
	};
}
function assertConnectionAccess(site: RuntimeSite, user: SitePrincipal | null) {
	if (!user) {
		throw new SiteError("unauthorized", "Sign in to use connected tools", 401);
	}
	if (
		site.settings.mode !== "connected" ||
		!site.settings.workspaceId ||
		!user.workspaceIds.includes(site.settings.workspaceId) ||
		site.settings.audience === "public"
	) {
		throw new SiteError(
			"forbidden",
			"Connected tools require access to this Site's workspace",
			403
		);
	}
}
export async function handleConnections(input: ConnectionRequest) {
	const { request, site, user, services, store } = input;
	if (!user) {
		throw new SiteError("unauthorized", "Sign in to use connected tools", 401);
	}
	assertConnectionAccess(site, user);
	const allowed = siteConnections(site, services);
	const consent = (id: string, revision: string) =>
		Boolean(
			store.db
				.query(
					"SELECT 1 FROM connection_consents WHERE site=? AND owner=? AND connection=? AND revision=?"
				)
				.get(site.id, user.id, id, revision)
		);
	if (request.method === "GET") {
		return json({
			connections: allowed.map((connection) => ({
				id: connection.id,
				label: connection.label,
				description: connection.description,
				readOnly: connection.readOnly,
				revision: connection.revision,
				source: connection.source,
				consented: consent(connection.id, connection.revision),
			})),
		});
	}
	const operation = z
		.object({
			action: z.enum(["revoke", "invoke"]),
			connectionId: z.string().max(100),
			revision: z.string().max(64),
			arguments: siteDataRecordSchema.default({}),
			confirmWrite: z.boolean().default(false),
		})
		.strict()
		.parse(await input.body());
	const connection = allowed.find(
		(candidate) => candidate.id === operation.connectionId
	);
	if (!connection) {
		throw new SiteError(
			"tool_not_allowed",
			"This connection is not approved for the Site",
			403
		);
	}
	const { revision } = connection;
	if (operation.revision !== revision) {
		throw new SiteError(
			"conflict",
			"Connection permissions changed. Review them again.",
			409
		);
	}
	if (operation.action === "revoke") {
		store.db
			.query(
				"DELETE FROM connection_consents WHERE site=? AND owner=? AND connection=?"
			)
			.run(site.id, user.id, connection.id);
		return json({ revoked: true });
	}
	if (!consent(connection.id, revision)) {
		throw new SiteError(
			"consent_required",
			"Review and allow this connection first",
			403
		);
	}
	if (!(connection.readOnly || operation.confirmWrite)) {
		throw new SiteError(
			"confirmation_required",
			"Confirm this write action before submitting",
			403
		);
	}
	if (!services.invokeConnection) {
		throw new SiteError(
			"unavailable",
			"Connected tool execution is unavailable",
			503
		);
	}
	chargeConnectionCall(store, site.id, user.id);
	const result = await services.invokeConnection({
		request,
		// Only the binding reaches the platform adapter, never visitor input.
		connection: {
			id: connection.id,
			label: connection.label,
			toolId: connection.toolId,
			agentId: connection.agentId,
			readOnly: connection.readOnly,
		},
		arguments: operation.arguments,
	});
	return json({ result });
}
/**
 * Counts one connected tool call against the visitor's daily share. The
 * per-address minute budget still applies first; this bounds a signed-in
 * visitor across addresses.
 */
function chargeConnectionCall(
	store: SitesStore,
	siteId: string,
	userId: string
) {
	const day = new Date().toISOString().slice(0, 10);
	store.pruneUsage(day);
	const kind = `connection:${store.visitorQuotaKey(siteId, day, `user:${userId}`)}`;
	store.db.transaction(() => {
		const used =
			z
				.object({ count: z.number() })
				.nullable()
				.parse(
					store.db
						.query(
							"SELECT count FROM operation_usage WHERE site=? AND day=? AND kind=?"
						)
						.get(siteId, day, kind)
				)?.count ?? 0;
		if (used >= SITE_LIMITS.connectionCallsPerVisitor) {
			throw new SiteError(
				"quota",
				"You have reached your daily connected tool limit for this Site",
				429
			);
		}
		store.db
			.query(
				"INSERT INTO operation_usage VALUES(?,?,?,1) ON CONFLICT(site,day,kind) DO UPDATE SET count=count+1"
			)
			.run(siteId, day, kind);
	})();
}
