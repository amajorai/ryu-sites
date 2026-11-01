import type {
	RuntimeSite,
	SitePrincipal,
} from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
import { createSitesServer } from "../../sidecar/src/server.ts";
import { SitesStore } from "../../sidecar/src/store.ts";
import { starterHtml } from "../../sidecar/src/templates.ts";
import { visitorScript } from "../../sidecar/src/visitor-bundle.ts";

// Real HTTP/browser boundary; identity and agent execution are isolated fixtures.
const owner: SitePrincipal = {
	id: "proof-owner",
	email: "owner@example.com",
	workspaceIds: ["proof-team"],
};
const editor: SitePrincipal = {
	id: "proof-editor",
	email: "editor@example.com",
	workspaceIds: ["proof-team"],
};
const token = crypto.randomUUID();
const calls: string[] = [];
const store = new SitesStore(":memory:");
const server = createSitesServer({
	store,
	token,
	ownerId: owner.id,
	port: 0,
	visitorPort: 8452,
	visitorScript,
	services: {
		identity: async (request) =>
			request.headers.get("cookie")?.includes("reset-proof=owner")
				? owner
				: null,
		managementIdentity: async (request) =>
			request.headers.get("x-proof-editor") === "true" ? editor : owner,
		scanArtifact: async () => ({ allowed: true, reason: null }),
		runResetAction: async ({ provider }) => {
			calls.push(provider);
			return {
				provider,
				status: "completed",
				detail: `${provider}: scheduled. Connected-account reset is tomorrow. No reset was redeemed.`,
			};
		},
	},
});
async function admin(
	path: string,
	body: SiteDataValue,
	asEditor = false
): Promise<RuntimeSite> {
	const response = await fetch(
		`http://127.0.0.1:${server.admin.port}/projects${path}`,
		{
			method: path.endsWith("settings") ? "PUT" : "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"x-proof-editor": String(asEditor),
			},
			body: JSON.stringify(body),
		}
	);
	if (!response.ok) {
		throw new Error(await response.text());
	}
	return response.json();
}
let site = await admin("", {
	name: "Reset account checks",
	slug: "reset-account-checks",
	template: "reset-calendar",
});
site = await admin(`/${site.id}/settings`, {
	expectedRevision: site.revision,
	settings: {
		...site.settings,
		agentActions: true,
		workspaceId: "proof-team",
		editors: [editor.email],
	},
});
site = await admin(`/${site.id}/versions`, {
	expectedRevision: site.revision,
	html: starterHtml(site.name, site.template, "Track account reset windows."),
	message: "Owner's initial publication",
});
site = await admin(`/${site.id}/deploy`, {
	expectedRevision: site.revision,
	versionId: site.versions.at(-1)?.id,
});
const malicious = `<!doctype html><html lang="en"><head><title>Edited reset calendar</title></head><body><h1>Edited reset calendar</h1><p id="result">Checking visitor boundary…</p><script>Promise.all(['codex','claude'].map(provider=>fetch('/_ryu/reset',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({provider})}).then(r=>r.status))).then(statuses=>document.getElementById('result').textContent='Visitor requests refused: '+statuses.join(', '));</script></body></html>`;
site = await admin(
	`/${site.id}/versions`,
	{
		expectedRevision: site.revision,
		html: malicious,
		message: "Editor-authored auto-run attempt",
	},
	true
);
site = await admin(
	`/${site.id}/deploy`,
	{ expectedRevision: site.revision, versionId: site.versions.at(-1)?.id },
	true
);
const html = await Bun.file(
	new URL("../dist/index.html", import.meta.url)
).text();
const bootstrap = `<script>window.ryu={app:{async request(input){const r=await fetch('/__sites'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},body:input.body===undefined?undefined:JSON.stringify(input.body)});const data=await r.json();if(!r.ok)throw Error(data.error?.message||'Request failed');return data}}};</script>`;
const ui = Bun.serve({
	hostname: "127.0.0.1",
	port: 8451,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.hostname !== "127.0.0.1") {
			return new Response("Forbidden", { status: 403 });
		}
		if (url.pathname === "/__proof") {
			if (url.searchParams.get("reset") === "1") {
				calls.length = 0;
			}
			return Response.json({
				calls,
				siteId: site.id,
				visitorUrl: `http://${site.slug}.localhost:8452`,
			});
		}
		if (url.pathname.startsWith("/__sites/")) {
			if (
				request.method !== "GET" &&
				request.headers.get("origin") !== url.origin
			) {
				return new Response("Forbidden", { status: 403 });
			}
			return fetch(
				`http://127.0.0.1:${server.admin.port}${url.pathname.slice(8)}${url.search}`,
				{
					method: request.method,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body:
						request.method === "GET" ? undefined : await request.arrayBuffer(),
				}
			);
		}
		return url.pathname === "/"
			? new Response(html.replace("<head>", `<head>${bootstrap}`), {
					headers: { "content-type": "text/html" },
				})
			: new Response("Not found", { status: 404 });
	},
});
process.once("SIGTERM", () => {
	ui.stop(true);
	server.stop();
	store.close();
});
console.info(
	"Sites reset proof: Companion 8451, visitor 8452. Isolated identity and agent fixtures."
);
