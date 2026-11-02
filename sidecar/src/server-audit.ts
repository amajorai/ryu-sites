/**
 * The Site audit entries written by the management listener: agent-tool
 * mutations, owner-connection changes and remixes.
 */
import { z } from "zod";
import type { SitesStore } from "./store.ts";

/**
 * Marks a management call made by the Sites MCP tools for the main Ryu agent.
 * It only labels the Site audit entry; authorization is the same bearer and
 * caller resolution the Companion uses, so the header grants nothing.
 */
export const SITES_AGENT_CLIENT_HEADER = "x-ryu-sites-client";
export const SITES_AGENT_CLIENT = "agent-tools";
/** Site audit action for a successful agent-tool mutation. */
export const AGENT_AUDIT_ACTION = "agent.tool";
/** Agent audit entries kept per Site; older ones are pruned on write. */
export const AGENT_AUDIT_RETAINED = 500;
const auditedSite = z.object({
	id: z.string(),
	revision: z.number(),
	deploymentId: z.string().nullable(),
	versions: z.array(z.object({ id: z.string() })),
});
/**
 * Records a successful agent-tool mutation in the Site audit: the verified
 * actor, the operation, and the resulting revision and deployment. HTML,
 * prompts and access lists are never copied into the audit.
 */
export async function auditAgentMutation(
	store: SitesStore,
	request: Request,
	response: Response,
	actor: string
) {
	if (request.method === "GET" || !response.ok) {
		return;
	}
	const path = new URL(request.url).pathname.replace(
		/^\/api\/sites(?=\/|$)/,
		""
	);
	const match = /^\/projects(?:\/([^/]+)(?:\/(.*))?)?$/.exec(path);
	if (!match) {
		return;
	}
	const result = auditedSite.safeParse(
		await response
			.clone()
			.json()
			.catch(() => null)
	);
	if (!result.success) {
		return;
	}
	const site = result.data;
	const operation = match[1]
		? match[2] || request.method.toLowerCase()
		: "create";
	store.db.transaction(() => {
		store.db.query("INSERT INTO site_audit VALUES(?,?,?,?,?,?)").run(
			site.id,
			new Date().toISOString(),
			actor,
			AGENT_AUDIT_ACTION,
			operation,
			JSON.stringify({
				revision: site.revision,
				deploymentId: site.deploymentId,
				latestVersionId: site.versions.at(-1)?.id ?? null,
			})
		);
		store.db
			.query(
				"DELETE FROM site_audit WHERE site=? AND action=? AND rowid NOT IN (SELECT rowid FROM site_audit WHERE site=? AND action=? ORDER BY rowid DESC LIMIT ?)"
			)
			.run(
				site.id,
				AGENT_AUDIT_ACTION,
				site.id,
				AGENT_AUDIT_ACTION,
				AGENT_AUDIT_RETAINED
			);
	})();
}
/** Site audit action for a change to owner-managed connections. */
export const CONNECTIONS_AUDIT_ACTION = "connections.update";
/** Connection audit entries kept per Site; older ones are pruned on write. */
export const CONNECTIONS_AUDIT_RETAINED = 200;
/**
 * Records who changed which owner bindings. Tool IDs and access levels are
 * operator-visible configuration, not visitor data or credentials.
 */
export function auditConnectionChange(
	store: SitesStore,
	siteId: string,
	actor: string,
	detail: {
		added: string[];
		changed: string[];
		removed: string[];
		revision: number;
	}
) {
	store.db
		.query("INSERT INTO site_audit VALUES(?,?,?,?,?,?)")
		.run(
			siteId,
			new Date().toISOString(),
			actor,
			CONNECTIONS_AUDIT_ACTION,
			"connections",
			JSON.stringify(detail)
		);
	store.db
		.query(
			"DELETE FROM site_audit WHERE site=? AND action=? AND rowid NOT IN (SELECT rowid FROM site_audit WHERE site=? AND action=? ORDER BY rowid DESC LIMIT ?)"
		)
		.run(
			siteId,
			CONNECTIONS_AUDIT_ACTION,
			siteId,
			CONNECTIONS_AUDIT_ACTION,
			CONNECTIONS_AUDIT_RETAINED
		);
}
/** Site audit action on a Site started by remixing or duplicating another. */
export const REMIX_AUDIT_ACTION = "site.remix";
