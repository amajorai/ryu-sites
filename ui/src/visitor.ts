import {
	createBrowserStore,
	searchBrowserDocuments,
} from "@ryu/browser-local-ai/data";

async function request(
	path: string,
	method = "GET",
	body?: unknown
): Promise<unknown> {
	const response = await fetch(`/_ryu/${path}`, {
		method,
		credentials: "same-origin",
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const result = await response.json();
	if (!response.ok) {
		throw new Error(result.error?.message ?? "Site service unavailable");
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
	capabilities: () =>
		globalThis.origin === "null"
			? Promise.resolve({
					mode: "local",
					knowledge: false,
					resetActions: false,
				})
			: request("config"),
	requestReset: (provider: "codex" | "claude" | "copilot") => {
		if (globalThis.origin === "null") {
			return Promise.reject(
				new Error(
					"Deploy this site and sign in as its owner to run a reset check in Ryu."
				)
			);
		}
		return request("reset", "POST", { provider });
	},
	signIn: () => {
		location.assign("/_ryu/signin");
	},
	signOut: () => request("signout", "POST", {}),
	retrieve: (query: string) => request("search", "POST", { query }),
	ask: (query: string) => request("ask", "POST", { query }),
	records: {
		list: (collection: string) => request(`records/${name(collection)}`),
		set: (collection: string, key: string, value: unknown) =>
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
