import type { RuntimeSite } from "../../sidecar/src/contracts.ts";

export async function sitesRequest<T>(
	path: string,
	method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
	body?: unknown
): Promise<T> {
	if (!window.ryu?.app?.request) {
		throw new Error("Open Sites in Ryu to connect to its service.");
	}
	return (await window.ryu.app.request({ path, method, body })) as T;
}
export const projectPath = (site: RuntimeSite, action = "") =>
	`/projects/${site.id}${action ? `/${action}` : ""}`;
