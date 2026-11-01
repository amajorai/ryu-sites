import { createHash } from "node:crypto";
import type { RuntimeSite } from "./contracts.ts";
import type { SiteExtensions } from "./extensions.ts";

/** The template is cacheable; user identity and records arrive through tool calls. */
export function siteUiResource(
	site: RuntimeSite,
	extensions: SiteExtensions,
	html: string,
	runtime: string,
	origin: string
) {
	const binding = JSON.stringify({
		siteUrl: `${origin}/`,
		tools: extensions.tools.map(({ name, operation, collection }) => ({
			name,
			operation,
			collection,
		})),
	}).replaceAll("<", "\\u003c");
	const script = `globalThis.__RYU_SITE_MCP__=${binding};\n${runtime}`.replace(
		/<\/script/gi,
		"<\\/script"
	);
	const withoutRuntime = html.replace(
		/<script\b[^>]*\bsrc\s*=\s*["']\/_ryu\/runtime\.js["'][^>]*>\s*<\/script\s*>/gi,
		""
	);
	const insertion = `<script>${script}</script>`;
	const text = /<head\b[^>]*>/i.test(withoutRuntime)
		? withoutRuntime.replace(/<head\b[^>]*>/i, (head) => `${head}${insertion}`)
		: withoutRuntime.replace(
				/<!doctype html[^>]*>/i,
				(doctype) => `${doctype}${insertion}`
			);
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 24);
	return {
		uri: `ui://sites/${site.id}/${site.deploymentId}/${hash}.html`,
		mimeType: "text/html;profile=mcp-app",
		text,
		_meta: {
			ui: {
				prefersBorder: true,
				csp: { connectDomains: [], resourceDomains: [] },
			},
		},
	};
}
