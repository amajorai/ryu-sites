import type { SitePrincipal } from "../../sidecar/src/contracts.ts";
import {
	type SiteDataValue,
	siteDataValueSchema,
} from "../../sidecar/src/data-values.ts";
import { createSitesServer } from "../../sidecar/src/server.ts";
import type { LegacySiteRecord } from "../../sidecar/src/spaces-database.ts";
import { SitesStore } from "../../sidecar/src/store.ts";
import { visitorScript } from "../../sidecar/src/visitor-bundle.ts";

// Isolated browser evidence. Identity and external connector execution are fixtures.
const owner: SitePrincipal = {
	id: "proof-owner",
	email: "owner@example.com",
	workspaceIds: ["proof-team"],
};
const reader: SitePrincipal = {
	id: "proof-reader",
	email: "reader@example.com",
	workspaceIds: ["proof-team"],
};
const store = new SitesStore(":memory:");
const token = crypto.randomUUID();
const savedRecords: LegacySiteRecord[] = [];
interface ManagementCall {
	body?: SiteDataValue;
	method: string;
	ownerBearerForwarded: boolean;
	path: string;
	status?: number;
}
const managementCalls: ManagementCall[] = [];
const unknownRequests: string[] = [];
let connectorInvocations = 0;
const site = store.create(
	{ name: "Team task board", slug: "team-task-board", template: "dashboard" },
	owner
);
const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Team task board</title><style>body{font:16px system-ui;margin:0;background:#fafafa;color:#171717}main{max-width:760px;margin:64px auto;padding:32px;border:1px solid #ddd;border-radius:12px;background:white}h1{margin-top:0}button,a{font:inherit;padding:10px 16px;border:1px solid #ddd;border-radius:8px;background:white;color:inherit}button{cursor:pointer}section{margin:24px 0}pre{white-space:pre-wrap}p{line-height:1.5}</style></head><body><main><h1>Team task board</h1><p>Your tasks from your connected account.</p><section><button id="connect">Review connection permissions</button> <button id="refresh">Refresh my tasks</button></section><p id="status" role="status">Connect your account to load your tasks.</p><pre id="tasks"></pre><script src="/_ryu/runtime.js"></script><script>document.getElementById('connect').onclick=()=>RyuSite.connections.allow('tasks');document.getElementById('refresh').onclick=async()=>{const status=document.getElementById('status');status.textContent='Loading tasks…';try{const data=await RyuSite.connections.list();const c=data.connections.find(x=>x.id==='tasks');if(!c||!c.consented)throw Error('Review and allow the connection first.');const result=await RyuSite.connections.invoke(c.id,c.revision,{});document.getElementById('tasks').textContent=JSON.stringify(result.result,null,2);status.textContent='Tasks loaded from your account.';}catch(e){status.textContent=e.message;}};</script></main></body></html>`;
const publishedHtml = html.replace(
	"</body>",
	`<script>RyuSite.capabilities().then(c=>{if(c.connections!==false)return;document.getElementById('connect').hidden=true;const button=document.getElementById('refresh');button.textContent='Refresh saved tasks';document.getElementById('status').textContent='Read your saved tasks through the Site plugin.';button.onclick=async()=>{const status=document.getElementById('status');try{const rows=await RyuSite.records.list('todos');document.getElementById('tasks').textContent=JSON.stringify(rows,null,2);status.textContent='Saved tasks loaded from your account.';}catch(e){status.textContent=e.message;}};});</script></body>`
);
store.db
	.query("INSERT INTO artifacts VALUES(?,?,?)")
	.run(site.id, "initial", publishedHtml);
store.mutate(site.id, 0, (current) => {
	current.settings.mode = "connected";
	current.settings.audience = "workspace";
	current.settings.workspaceId = "proof-team";
	current.settings.storage = true;
	current.settings.database = {
		spaceId: "proof-space",
		databaseId: "proof-database",
	};
	current.versions = [
		{
			id: "initial",
			bytes: publishedHtml.length,
			message: "Task board",
			createdAt: new Date().toISOString(),
			commit: null,
		},
	];
	current.deploymentId = "initial";
	current.hasPublished = true;
});
const server = createSitesServer({
	store,
	token,
	ownerId: owner.id,
	port: 0,
	visitorPort: 8442,
	visitorScript,
	services: {
		spacesDatabase: {
			ensureForSite: async () => ({
				spaceId: "proof-space",
				databaseId: "proof-database",
			}),
			query: async () => ({
				columns: [],
				rows: [],
				schema: [],
				truncated: false,
			}),
			records: async (_binding, id, collection, key) =>
				savedRecords
					.filter(
						(record) =>
							record.owner === id &&
							record.collection === collection &&
							(key === null || record.key === key)
					)
					.map((record) => ({
						key: record.key,
						value: JSON.parse(record.value),
					})),
			saveRecord: async (_binding, record) => {
				const existing = savedRecords.findIndex(
					(item) =>
						item.owner === record.owner &&
						item.collection === record.collection &&
						item.key === record.key
				);
				if (existing >= 0) {
					savedRecords[existing] = record;
				} else {
					savedRecords.push(record);
				}
			},
			deleteRecord: async (_binding, id, collection, key) => {
				const index = savedRecords.findIndex(
					(record) =>
						record.owner === id &&
						record.collection === collection &&
						record.key === key
				);
				if (index < 0) {
					return false;
				}
				savedRecords.splice(index, 1);
				return true;
			},
			count: async () => savedRecords.length,
			ownerUsage: async () => [],
			deleteOwnerRecords: async () => 0,
			importRecords: async () => {},
			deleteDatabase: async () => {},
		},
		authorizationServer: "https://identity.example.com",
		managementIdentity: async () => owner,
		identity: async (request) =>
			request.headers.get("cookie")?.includes("sites-proof=reader")
				? reader
				: null,
		mcpIdentity: async (request) =>
			request.headers.get("authorization") === "Bearer sites-proof-reader"
				? reader
				: null,
		scanArtifact: async () => ({ allowed: true, reason: null }),
		installPlugin: async (manifest) => ({ installed: true, manifest }),
		connections: () => [
			{
				id: "tasks",
				label: "Task tracker",
				toolId: "tracker.my_tasks",
				agentId: "ryu",
				readOnly: true,
			},
		],
		invokeConnection: async ({ request }) => {
			connectorInvocations += 1;
			return {
				tasks: [
					{
						title: "Review launch checklist",
						assignedTo: (await serverIdentity(request))?.email,
					},
				],
			};
		},
	},
});
async function serverIdentity(request: Request) {
	return request.headers.get("cookie")?.includes("sites-proof=reader")
		? reader
		: null;
}
const companion = await Bun.file(
	new URL("../dist/index.html", import.meta.url)
).text();
const bootstrap = `<script>window.ryu={app:{async request(input){const response=await fetch('/__sites'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},body:input.body===undefined?undefined:JSON.stringify(input.body)});const data=await response.json();if(!response.ok)throw Error(data.error?.message||'Request failed');return data}}};</script>`;
const ui = Bun.serve({
	hostname: "127.0.0.1",
	port: 8441,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.hostname !== "127.0.0.1") {
			return new Response("Forbidden", { status: 403 });
		}
		if (url.pathname === "/__proof/events" && request.method === "GET") {
			return Response.json({
				managementCalls,
				unknownRequests,
				connectorInvocations,
			});
		}
		if (url.pathname.startsWith("/__sites/")) {
			if (
				request.method !== "GET" &&
				request.headers.get("origin") !== url.origin
			) {
				return new Response("Forbidden", { status: 403 });
			}
			const pathname = url.pathname.slice(8);
			const knownGet =
				request.method === "GET" &&
				((pathname === "/projects" &&
					["", "?scope=owned", "?scope=shared"].includes(url.search)) ||
					([
						"/status",
						"/runtime",
						`/projects/${site.id}`,
						`/projects/${site.id}/extensions`,
					].includes(pathname) &&
						!url.search) ||
					(!url.search &&
						store
							.get(site.id)
							.versions.some(
								(version) =>
									pathname === `/projects/${site.id}/versions/${version.id}`
							)));
			const knownWrite =
				!url.search &&
				((request.method === "PUT" &&
					pathname === `/projects/${site.id}/extensions`) ||
					(request.method === "POST" &&
						[
							`/projects/${site.id}/versions`,
							`/projects/${site.id}/deploy`,
							`/projects/${site.id}/install-plugin`,
						].includes(pathname)));
			if (!(knownGet || knownWrite)) {
				unknownRequests.push(`${request.method} ${pathname}${url.search}`);
				return Response.json(
					{ error: { message: "Unexpected proof management request" } },
					{ status: 500 }
				);
			}
			const body = request.method === "GET" ? undefined : await request.text();
			const call: ManagementCall = (() => {
				const value0 = {
					method: request.method,
					path: `${pathname}${url.search}`,
				};
				const value1 =
					body === undefined
						? value0
						: Object.assign(value0, {
								body: siteDataValueSchema.parse(JSON.parse(body)),
							});
				const value2 = Object.assign(value1, { ownerBearerForwarded: true });
				return value2;
			})();
			managementCalls.push(call);
			const response = await fetch(
				`http://127.0.0.1:${server.admin.port}${pathname}${url.search}`,
				{
					method: request.method,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body,
				}
			);
			call.status = response.status;
			return response;
		}
		if (
			url.pathname === "/__widget-rpc" &&
			request.method === "POST" &&
			request.headers.get("origin") === url.origin
		) {
			return fetch("http://127.0.0.1:8442/mcp", {
				method: "POST",
				headers: {
					host: "team-task-board.localhost:8442",
					authorization: "Bearer sites-proof-reader",
					"content-type": "application/json",
				},
				body: await request.text(),
			});
		}
		if (url.pathname === "/") {
			return new Response(companion.replace("<head>", `<head>${bootstrap}`), {
				headers: { "content-type": "text/html" },
			});
		}
		return new Response("Not found", { status: 404 });
	},
});
process.once("SIGTERM", () => {
	ui.stop(true);
	server.stop();
	store.close();
});
console.info(
	"Sites extension proof: Companion 8441, visitor 8442. Isolated identity/connector fixtures."
);
