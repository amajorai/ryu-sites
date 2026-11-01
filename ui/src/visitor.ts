import {
	createBrowserStore,
	searchBrowserDocuments,
} from "@ryu/browser-local-ai/data";
import { z } from "zod";
import {
	type SiteDataRecord,
	type SiteDataValue,
	siteDataValueSchema,
} from "../../sidecar/src/data-values.ts";
import { mcpBinding, requestMcp } from "./mcp-transport.ts";
import { createSharedCollection } from "./shared-client.ts";

async function request(
	path: string,
	method = "GET",
	body?: SiteDataValue
): Promise<SiteDataValue> {
	if (mcpBinding) {
		return requestMcp(path, method, body);
	}
	const options = {
		method,
		credentials: "same-origin",
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	} satisfies RequestInit;
	const response = await fetch(`/_ryu/${path}`, options);
	const result = siteDataValueSchema.parse(await response.json());
	if (!response.ok) {
		const error = z
			.object({
				error: z
					.object({
						code: z.string().nullish(),
						message: z.string().nullish(),
					})
					.optional(),
				current: siteDataValueSchema.optional(),
			})
			.safeParse(result);
		// Status, code and (for a 409) the current shared record let a page
		// resolve a conflict instead of retrying blindly.
		throw Object.assign(
			new Error(
				error.success
					? (error.data.error?.message ?? "Site service unavailable")
					: "Site service unavailable"
			),
			{
				status: response.status,
				code: error.success ? (error.data.error?.code ?? null) : null,
				current: error.success ? (error.data.current ?? null) : null,
			}
		);
	}
	return result;
}
const name = (value: string) => {
	if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) {
		throw new Error("Invalid resource name");
	}
	return value;
};
const siteRuntime = {
	local: createBrowserStore,
	search: searchBrowserDocuments,
	identity: () => request("identity"),
	connections: {
		list: () => request("connections"),
		allow: (connectionId: string) =>
			location.assign(
				`/_ryu/connections/consent?connectionId=${encodeURIComponent(connectionId)}`
			),
		revoke: (connectionId: string, revision: string) =>
			request("connections", "POST", {
				action: "revoke",
				connectionId,
				revision,
			}),
		invoke: (
			connectionId: string,
			revision: string,
			args: SiteDataRecord,
			confirmWrite = false
		) =>
			request("connections", "POST", {
				action: "invoke",
				connectionId,
				revision,
				arguments: args,
				confirmWrite,
			}),
	},
	capabilities: () =>
		globalThis.origin === "null" && !mcpBinding
			? Promise.resolve({
					mode: "local",
					knowledge: false,
					resetActions: false,
					remixable: false,
				})
			: request("config"),
	requestReset: (_provider: "codex" | "claude" | "copilot") =>
		Promise.reject(new Error("Run reset checks from Ryu Sites Settings.")),
	signIn: () => {
		location.assign("/_ryu/signin");
	},
	signOut: () => request("signout", "POST", {}),
	retrieve: (query: string) => request("search", "POST", { query }),
	ask: (query: string) => request("ask", "POST", { query }),
	/**
	 * General in-page AI (`aiMode: general`). Errors keep their status:
	 * 401 sign in, 403 disabled, 413 too long, 429 daily limit, 503 no model.
	 */
	ai: {
		complete: (input: {
			prompt: string;
			system?: string;
			maxTokens?: number;
		}) =>
			request("complete", "POST", {
				prompt: input.prompt,
				...(input.system === undefined ? {} : { system: input.system }),
				...(input.maxTokens === undefined
					? {}
					: { maxTokens: input.maxTokens }),
			}),
		chat: (
			messages: { role: "user" | "assistant"; content: string }[],
			options: { system?: string; maxTokens?: number } = {}
		) =>
			request("complete", "POST", {
				messages,
				...(options.system === undefined ? {} : { system: options.system }),
				...(options.maxTokens === undefined
					? {}
					: { maxTokens: options.maxTokens }),
			}),
	},
	shared: (collection: string) =>
		createSharedCollection(
			collection,
			(path, method, body) =>
				mcpBinding
					? Promise.reject(
							new Error("Shared data is available only on the Site itself")
						)
					: request(path, method, body),
			(url) => {
				if (mcpBinding) {
					throw new Error("Shared data is available only on the Site itself");
				}
				return new EventSource(url);
			}
		),
	records: {
		list: (collection: string) => request(`records/${name(collection)}`),
		set: (collection: string, key: string, value: SiteDataValue) =>
			request(`records/${name(collection)}/${name(key)}`, "PUT", value),
		delete: (collection: string, key: string) =>
			request(`records/${name(collection)}/${name(key)}`, "DELETE"),
	},
	files: {
		async upload(file: File) {
			if (file.size > 5_000_000) {
				throw new Error("File exceeds 5 MB");
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			let binary = "";
			for (const byte of bytes) {
				binary += String.fromCharCode(byte);
			}
			return request("files", "POST", { name: file.name, data: btoa(binary) });
		},
		url: (id: string) => `/_ryu/files/${encodeURIComponent(id)}`,
	},
};
Object.defineProperty(globalThis, "RyuSite", { value: siteRuntime });
