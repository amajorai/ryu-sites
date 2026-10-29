import { z } from "zod";
import {
	type SiteDataValue,
	siteDataValueSchema,
} from "../../sidecar/src/data-values.ts";
import { siteTool } from "../../sidecar/src/extensions.ts";

const bindingSchema = z
	.object({
		siteUrl: z.url(),
		tools: z
			.array(siteTool.pick({ name: true, operation: true, collection: true }))
			.max(20),
	})
	.strict();
declare global {
	var __RYU_SITE_MCP__: SiteDataValue;
	var openai:
		| { callTool(name: string, args: SiteDataValue): Promise<SiteDataValue> }
		| undefined;
}
const parsed = bindingSchema.safeParse(globalThis.__RYU_SITE_MCP__);
export const mcpBinding = parsed.success ? parsed.data : null;
const pending = new Map<
	number,
	{
		resolve: (value: SiteDataValue) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}
>();
let nextId = 1;
let initialized = Promise.resolve(true);
let finishInitialization: (success: boolean) => void = () => {};
if (mcpBinding && globalThis.window !== undefined && window.parent !== window) {
	initialized = new Promise<boolean>((resolve) => {
		finishInitialization = resolve;
		setTimeout(() => resolve(false), 10_000);
	});
	window.addEventListener("message", (event: MessageEvent<SiteDataValue>) => {
		if (event.source !== window.parent) {
			return;
		}
		const decoded = z
			.object({ id: z.union([z.string(), z.number()]) })
			.loose()
			.safeParse(event.data);
		if (!decoded.success) {
			return;
		}
		const data = decoded.data;
		if (data.id === "sites-initialize") {
			finishInitialization("result" in data);
			window.parent.postMessage(
				{ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
				"*"
			);
			return;
		}
		if (!z.number().safeParse(data.id).success) {
			return;
		}
		const request = pending.get(z.number().parse(data.id));
		if (!request) {
			return;
		}
		clearTimeout(request.timeout);
		pending.delete(z.number().parse(data.id));
		if ("error" in data) {
			request.reject(new Error("The app host refused this request."));
		} else if ("result" in data) {
			request.resolve(siteDataValueSchema.parse(data.result));
		}
	});
	window.parent.postMessage(
		{
			jsonrpc: "2.0",
			id: "sites-initialize",
			method: "ui/initialize",
			params: {
				appInfo: { name: "Ryu Sites", version: "0.1.0" },
				appCapabilities: {},
				protocolVersion: "2026-01-26",
			},
		},
		"*"
	);
}
async function callTool(
	name: string,
	args: SiteDataValue
): Promise<SiteDataValue> {
	const bridge = globalThis.openai;
	let raw: SiteDataValue;
	if (
		bridge &&
		z.object({ callTool: z.function() }).safeParse(bridge).success
	) {
		raw = await bridge.callTool(name, args);
	} else {
		if (globalThis.window === undefined || window.parent === window) {
			throw new Error("Open this Site view in an MCP Apps host.");
		}
		if (pending.size >= 20) {
			throw new Error("Too many pending Site requests.");
		}
		if (!(await initialized)) {
			throw new Error("The app host could not initialize this Site view.");
		}
		const id = nextId++;
		raw = await new Promise<SiteDataValue>((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(
					new Error(
						"The Site request timed out. Check its state before retrying."
					)
				);
			}, 30_000);
			pending.set(id, { resolve, reject, timeout });
			window.parent.postMessage(
				{
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: { name, arguments: args },
				},
				"*"
			);
		});
	}
	const result = z
		.object({
			isError: z.boolean().optional(),
			structuredContent: z.object({ result: siteDataValueSchema }).optional(),
			content: z
				.array(z.object({ type: z.string(), text: z.string().optional() }))
				.optional(),
		})
		.parse(raw);
	if (result.isError) {
		throw new Error(
			result.content?.find((item) => item.type === "text")?.text ??
				"The Site tool did not complete."
		);
	}
	if (!result.structuredContent) {
		throw new Error("The Site tool returned an incompatible result.");
	}
	return result.structuredContent.result;
}
export async function requestMcp(
	path: string,
	method: string,
	body?: SiteDataValue
) {
	if (!mcpBinding) {
		throw new Error("Site UI binding is unavailable.");
	}
	if (path === "identity" || path === "config") {
		const context = z
			.object({
				identity: siteDataValueSchema,
				capabilities: siteDataValueSchema,
			})
			.parse(await callTool("ryu_site_context", {}));
		return path === "identity" ? context.identity : context.capabilities;
	}
	if (path === "search") {
		const tool = mcpBinding.tools.find(
			(item) => item.operation === "knowledge.search"
		);
		if (!tool) {
			throw new Error(
				"Publish a knowledge search tool to use it in this view."
			);
		}
		return callTool(tool.name, body);
	}
	const record =
		/^records\/([a-zA-Z][a-zA-Z0-9_-]{0,63})(?:\/([a-zA-Z][a-zA-Z0-9_-]{0,63}))?$/.exec(
			path
		);
	if (!record) {
		throw new Error(
			"Open the Site in a browser to use connected apps, uploads or sign-in."
		);
	}
	const operation =
		method === "GET"
			? "records.list"
			: method === "PUT"
				? "records.set"
				: method === "DELETE"
					? "records.delete"
					: null;
	if (
		(operation === "records.set" || operation === "records.delete") &&
		!record[2]
	) {
		throw new Error("A record key is required for this action.");
	}
	const tool = mcpBinding.tools.find(
		(item) => item.operation === operation && item.collection === record[1]
	);
	if (!tool) {
		throw new Error(
			"Publish a matching record tool to use this action in the Site view."
		);
	}
	const result = await callTool(
		tool.name,
		operation === "records.list"
			? {}
			: operation === "records.set"
				? { key: record[2], value: body }
				: { key: record[2] }
	);
	if (operation === "records.list" && record[2]) {
		return z
			.array(z.object({ key: z.string(), value: siteDataValueSchema }))
			.parse(result)
			.filter((item) => item.key === record[2]);
	}
	return result;
}
