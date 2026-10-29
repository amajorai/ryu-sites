import type { z } from "zod";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";

export async function sitesRequest<T>(
	schema: z.ZodType<T>,
	path: string,
	method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
	body?: SiteDataValue
): Promise<T> {
	if (!window.ryu?.app?.request) {
		throw new Error("Open Sites in Ryu to connect to its service.");
	}
	return schema.parse(await window.ryu.app.request({ path, method, body }));
}
export const projectPath = (site: RuntimeSite, action = "") =>
	`/projects/${site.id}${action ? `/${action}` : ""}`;
