import { z } from "zod";
import {
	type RuntimeSite,
	SITE_LIMITS,
	type SitePrincipal,
} from "./contracts.ts";
import {
	type SiteDataValue,
	siteDataRecordSchema,
	siteDataValueSchema,
} from "./data-values.ts";
import {
	type ApprovedConnection,
	describeSiteTool,
	siteExtensions,
	toolArguments,
} from "./extensions.ts";
import { escapeHtml } from "./html.ts";
import { siteUiResource } from "./mcp-ui.ts";
import {
	operatorConnectionRevision,
	readOwnerConnectionPolicy,
	resolveSiteConnections,
	type SiteConnection,
} from "./owner-connections.ts";
import type { SitesServices } from "./server.ts";
import { SiteError, type SitesStore } from "./store.ts";

const json = (
	value: SiteDataValue,
	status = 200,
	headers: Record<string, string> = {}
) =>
	Response.json(value, {
		status,
		headers: {
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
			...headers,
		},
	});
export function connectionRevision(connection: ApprovedConnection) {
	return operatorConnectionRevision(connection);
}
/**
 * Every connection visitors of the deployed Site may review: operator
 * bindings its deployed version selected and owner bindings the operator
 * policy allows. Each carries its source and consent revision.
 */
export function siteConnections(
	site: RuntimeSite,
	services: SitesServices
): SiteConnection[] {
	return resolveSiteConnections({
		site,
		operator: services.connections?.(site.id) ?? [],
		operatorSelected: deployedExtensions(site).connections,
		policy: readOwnerConnectionPolicy(services.ownerConnectionPolicy),
	});
}
export function deployedExtensions(site: RuntimeSite) {
	return siteExtensions.parse(
		site.versions.find((version) => version.id === site.deploymentId)
			?.extensions
	);
}
export function sitePlugin(site: RuntimeSite, origin: string) {
	const endpoint = new URL("/mcp", origin);
	if (
		endpoint.protocol === "http:" &&
		(endpoint.hostname === "localhost" ||
			endpoint.hostname.endsWith(".localhost"))
	) {
		endpoint.hostname = "127.0.0.1";
		endpoint.pathname = `/sites/${site.id}/mcp`;
	}
	return {
		id: `com.local.sites.site-${site.id}`,
		name: site.name,
		version: `0.1.${site.versions.findIndex((version) => version.id === site.deploymentId) + 1}`,
		description: `Tools for ${site.name}. Each user connects with their own Site access.`,
		engines: { ryu: ">=0.1.0" },
		permission_grants: ["mcp:server", "identity.read"],
		mcp_servers: {
			site: {
				type: "streamable-http" as const,
				url: endpoint.href,
				auth: { type: "oauth" as const },
			},
		},
	};
}
export async function handleSiteMcp(input: {
	request: Request;
	site: RuntimeSite;
	user: SitePrincipal;
	services: SitesServices;
	html: string;
	visitorScript: string;
	body: SiteDataValue;
	data: (request: Request, url: URL) => Promise<Response>;
}) {
	const { request, site } = input;
	const config = deployedExtensions(site);
	const ui =
		config.ui && input.visitorScript
			? siteUiResource(
					site,
					config,
					input.html,
					input.visitorScript,
					new URL(request.url).origin.replace(
						"127.0.0.1",
						`${site.slug}.localhost`
					)
				)
			: null;
	if (!config.mcp) {
		throw new SiteError(
			"disabled",
			"MCP tools are not published for this Site",
			404
		);
	}
	const rpc = z
		.object({
			jsonrpc: z.literal("2.0"),
			id: z.union([z.string().max(100), z.number(), z.null()]).optional(),
			method: z.string().max(100),
			params: siteDataRecordSchema.optional(),
		})
		.strict()
		.safeParse(input.body);
	if (!rpc.success) {
		return json(
			{
				jsonrpc: "2.0",
				id: null,
				error: { code: -32_600, message: "Invalid MCP request" },
			},
			400
		);
	}
	const { id, method, params } = rpc.data;
	if (method === "notifications/initialized" && id === undefined) {
		return new Response(null, { status: 202 });
	}
	if (id === undefined) {
		return json(
			{
				jsonrpc: "2.0",
				id: null,
				error: { code: -32_600, message: "Request ID required" },
			},
			400
		);
	}
	const reply = (result: SiteDataValue) => json({ jsonrpc: "2.0", id, result });
	const error = (code: number, message: string) =>
		json({ jsonrpc: "2.0", id, error: { code, message } });
	if (method === "initialize") {
		const init = z
			.object({
				protocolVersion: z.string().min(1).max(40),
				capabilities: siteDataRecordSchema,
				clientInfo: z.object({ name: z.string(), version: z.string() }),
			})
			.safeParse(params);
		if (!init.success) {
			return error(-32_602, "Unsupported initialization parameters");
		}
		return reply({
			protocolVersion: [
				"2024-11-05",
				"2025-03-26",
				"2025-06-18",
				"2025-11-25",
			].includes(init.data.protocolVersion)
				? init.data.protocolVersion
				: "2025-11-25",
			capabilities: (() => {
				const capabilities = { tools: {} };
				if (ui) {
					Object.assign(capabilities, {
						resources: {},
						extensions: {
							"io.modelcontextprotocol/ui": {
								mimeTypes: ["text/html;profile=mcp-app"],
							},
						},
					});
				}
				return capabilities;
			})(),
			serverInfo: { name: site.name, version: "0.1.0" },
		});
	}
	if (method === "ping") {
		return reply({});
	}
	if (method === "tools/list") {
		return reply({
			tools: [
				...config.tools.map((tool) => {
					const description = describeSiteTool(tool);
					const publishedTool = {
						...description,
						inputSchema: siteDataRecordSchema.parse(description.inputSchema),
					};
					if (ui) {
						Object.assign(publishedTool, {
							_meta: {
								ui: { resourceUri: ui.uri },
								"openai/outputTemplate": ui.uri,
								"openai/ui": {
									entrypoints: [{ type: "global" }, { type: "thread" }],
								},
							},
						});
					}
					return publishedTool;
				}),
				...(ui
					? [
							{
								name: "ryu_site_context",
								description: "Read the current user's Site view context.",
								inputSchema: {
									type: "object",
									properties: {},
									additionalProperties: false,
								},
								annotations: { readOnlyHint: true },
								_meta: { ui: { visibility: ["app"] } },
							},
						]
					: []),
			],
		});
	}
	if (method === "resources/list") {
		return reply({
			resources: ui
				? [{ uri: ui.uri, name: site.name, mimeType: ui.mimeType }]
				: [],
		});
	}
	if (method === "resources/read") {
		const resource = z
			.object({ uri: z.string().max(500) })
			.strict()
			.safeParse(params);
		return resource.success && ui && resource.data.uri === ui.uri
			? reply({ contents: [ui] })
			: error(-32_602, "Unknown Site UI resource");
	}
	if (method !== "tools/call") {
		return error(-32_601, "Method not found");
	}
	const call = z
		.object({
			name: z.string(),
			arguments: siteDataRecordSchema.default({}),
		})
		.strict()
		.safeParse(params);
	if (!call.success) {
		return error(-32_602, "Invalid tool call");
	}
	if (call.data.name === "ryu_site_context" && ui) {
		if (Object.keys(call.data.arguments).length) {
			return error(-32_602, "Site context takes no arguments");
		}
		const result = {
			identity: { id: input.user.id, email: input.user.email },
			capabilities: {
				mode: "connected",
				records: site.settings.storage,
				knowledge: Boolean(site.settings.spaceId && input.services.retrieve),
				answers: false,
				completions: false,
				uploads: false,
				connections: false,
			},
		};
		return reply({
			content: [{ type: "text", text: JSON.stringify(result) }],
			structuredContent: { result },
		});
	}
	const tool = config.tools.find(
		(candidate) => candidate.name === call.data.name
	);
	if (!tool) {
		return error(-32_602, "Unknown tool");
	}
	const args = toolArguments[tool.operation].safeParse(call.data.arguments);
	if (!args.success) {
		return error(-32_602, "Invalid tool arguments");
	}
	// Re-enter the SAME scoped application operations as the website. No SQL or code execution.
	let path = `/_ryu/records/${tool.collection}`;
	let verb = "GET";
	let body: string | undefined;
	if (tool.operation === "knowledge.search") {
		path = "/_ryu/search";
		verb = "POST";
		body = JSON.stringify(args.data);
	} else if ("key" in args.data) {
		path += `/${args.data.key}`;
		verb = tool.operation === "records.delete" ? "DELETE" : "PUT";
		if ("value" in args.data) {
			body = JSON.stringify(args.data.value);
		}
	}
	const url = new URL(path, request.url);
	try {
		const options = {
			method: verb,
			headers: { "content-type": "application/json" },
			body,
		} satisfies RequestInit;
		const response = await input.data(new Request(url, options), url);
		const result = siteDataValueSchema.parse(await response.json());
		const toolReply = {
			content: [{ type: "text", text: JSON.stringify(result) }],
			structuredContent: { result },
		};
		if (!response.ok) {
			Object.assign(toolReply, { isError: true });
		}
		return reply(toolReply);
	} catch (cause) {
		const message =
			cause instanceof SiteError
				? cause.message
				: "The Site tool could not complete";
		return reply({ isError: true, content: [{ type: "text", text: message }] });
	}
}

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
		return new Response(consentPage({ connection, site, user, ticket: id }), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "private, no-store",
				"content-security-policy":
					"default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
				"x-content-type-options": "nosniff",
			},
		});
	};
}
/**
 * The visitor's review page. For owner bindings, the label and description
 * are the author's own words, so they are set apart from the facts Sites
 * verified: the Core tool and agent that run, the enforced access, and
 * whether an owner or an editor added it.
 */
function consentPage(input: {
	connection: SiteConnection;
	site: RuntimeSite;
	user: SitePrincipal;
	ticket: string;
}) {
	const { connection, site, user } = input;
	const access = connection.readOnly ? "read access" : "read and write access";
	const author =
		connection.addedBy === "editor" ? "A Site editor" : "The Site owner";
	const described = connection.description
		? `<p>${escapeHtml(connection.description)}</p>`
		: "";
	const origin =
		connection.source === "owner"
			? `<section><h2>Written by ${connection.addedBy === "editor" ? "a Site editor" : "the Site owner"}</h2><p><strong>${escapeHtml(connection.label)}</strong></p>${described}</section><section><h2>Verified by Ryu</h2><p>${author} added this connection. It runs the Core tool <code>${escapeHtml(connection.toolId)}</code> through the agent <code>${escapeHtml(connection.agentId)}</code> with ${access}.</p></section>`
			: `${described}<p>Your Ryu operator approved this connection.</p>`;
	return `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Connection permissions</title><main><h1>Allow ${escapeHtml(connection.label)}?</h1>${origin}<p>${escapeHtml(site.name)} requests ${access} using your connected account. It runs as you, never as the Site owner.</p><p>Signed in as ${escapeHtml(user.email)}. Existing provider and workspace permissions still apply. You can revoke access at any time.</p><form method="post"><input type="hidden" name="ticket" value="${input.ticket}"><button name="decision" value="allow">Allow connection</button><button name="decision" value="cancel">Cancel</button></form></main></html>`;
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
