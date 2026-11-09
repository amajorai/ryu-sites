import { z } from "zod";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
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
import { siteUiResource } from "./mcp-ui.ts";
import {
	operatorConnectionRevision,
	readOwnerConnectionPolicy,
	resolveSiteConnections,
	type SiteConnection,
} from "./owner-connections.ts";
import type { SitesServices } from "./server.ts";
import { SiteError } from "./store.ts";

export {
	type ConnectionRequest,
	createConnectionConsent,
	handleConnections,
} from "./connection-routes.ts";

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
