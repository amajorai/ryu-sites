import { afterAll, beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { approvedConnection, siteExtensions } from "./extensions.ts";
import {
	applyOwnerConnections,
	DEFAULT_OWNER_CONNECTION_POLICY,
	type OwnerConnectionPolicy,
	ownerConnectionToolAllowed,
	resolveSiteConnections,
} from "./owner-connections.ts";
import { runtimeConfigSchema } from "./runtime-config.ts";
import { CONNECTIONS_AUDIT_ACTION, createSitesServer } from "./server.ts";
import { readStoredSite } from "./site-records.ts";
import { SitesStore } from "./store.ts";

const principals: Record<string, SitePrincipal> = {
	owner: { id: "owner", email: "owner@example.com", workspaceIds: ["team"] },
	editor: { id: "editor", email: "editor@example.com", workspaceIds: ["team"] },
	reader: { id: "reader", email: "reader@example.com", workspaceIds: ["team"] },
	outsider: {
		id: "outsider",
		email: "outsider@example.com",
		workspaceIds: ["other"],
	},
};
const operator = approvedConnection.parse({
	id: "issues",
	label: "Operator issues",
	toolId: "tracker.list",
	agentId: "ryu",
	readOnly: true,
});
const policyWith = (
	overrides: Partial<OwnerConnectionPolicy> = {}
): OwnerConnectionPolicy => ({
	...DEFAULT_OWNER_CONNECTION_POLICY,
	readOnlyTools: ["notion.*", "tracker.*"],
	...overrides,
});
let policy = policyWith();
let policyUnreadable = false;
const calls: { user: string; tool: string; agent: string }[] = [];
const store = new SitesStore(":memory:");
const site = store.create(
	{ name: "Team hub", slug: "team-hub" },
	principals.owner as SitePrincipal
);
store.db
	.query("INSERT INTO artifacts VALUES(?,?,?)")
	.run(site.id, "version-1", "<!doctype html><title>Team hub</title>");
const extensions = siteExtensions.parse({ connections: [operator.id] });
store.mutate(site.id, 0, (current) => {
	current.settings.mode = "connected";
	current.settings.audience = "workspace";
	current.settings.workspaceId = "team";
	current.settings.editors = ["editor@example.com"];
	current.settings.extensions = extensions;
	current.versions = [
		{
			id: "version-1",
			message: "Hub",
			createdAt: new Date().toISOString(),
			bytes: 40,
			commit: null,
			extensions,
		},
	];
	current.deploymentId = "version-1";
	current.hasPublished = true;
});
const server = createSitesServer({
	store,
	token: "test-only-app-token",
	port: 0,
	visitorPort: 0,
	services: {
		identity: async (request) =>
			principals[request.headers.get("cookie") ?? ""] ?? null,
		managementIdentity: async (request) =>
			principals[request.headers.get("x-test-user") ?? ""] ?? null,
		connections: () => [operator],
		ownerConnectionPolicy: () => {
			if (policyUnreadable) {
				throw new Error("runtime.json is mid-edit");
			}
			return policy;
		},
		invokeConnection: async ({ request, connection }) => {
			const user = request.headers.get("cookie") ?? "";
			calls.push({ user, tool: connection.toolId, agent: connection.agentId });
			return { ran: connection.toolId, as: user };
		},
	},
});
const unavailable = createSitesServer({
	store,
	token: "test-only-app-token",
	port: 0,
	visitorPort: 0,
	services: {
		managementIdentity: async () => principals.owner ?? null,
	},
});
afterAll(() => {
	server.stop();
	unavailable.stop();
	store.close();
});
beforeEach(() => {
	policy = policyWith();
	policyUnreadable = false;
	calls.length = 0;
	// Each test starts without owner bindings.
	store.mutate(site.id, store.get(site.id).revision, (current) => {
		current.connections = [];
	});
});

const siteSchema = z.object({
	revision: z.number(),
	connections: z.array(
		z.object({ id: z.string(), revision: z.number(), label: z.string() })
	),
});
const visitorListSchema = z.object({
	connections: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			description: z.string(),
			readOnly: z.boolean(),
			revision: z.string(),
			source: z.enum(["operator", "owner"]),
			consented: z.boolean(),
		})
	),
});

function admin(
	path: string,
	user: string,
	method = "GET",
	body?: SiteDataValue,
	target = server
) {
	return fetch(
		`http://127.0.0.1:${target.admin.port}/api/sites/projects/${site.id}${path}`,
		{
			method,
			headers: {
				authorization: "Bearer test-only-app-token",
				"x-test-user": user,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}
	);
}
const origin = () => `http://team-hub.localhost:${server.visitor.port}`;
function visitor(
	path: string,
	user: string,
	method = "GET",
	body?: SiteDataValue | string,
	extra: Record<string, string> = {}
) {
	return fetch(`http://127.0.0.1:${server.visitor.port}${path}`, {
		method,
		headers: {
			host: `team-hub.localhost:${server.visitor.port}`,
			cookie: user,
			origin: origin(),
			"content-type": "application/json",
			...extra,
		},
		body:
			body === undefined
				? undefined
				: typeof body === "string"
					? body
					: JSON.stringify(body),
		redirect: "manual",
	});
}
const navigation = {
	"sec-fetch-mode": "navigate",
	"sec-fetch-dest": "document",
	"sec-fetch-user": "?1",
};
async function allow(user: string, connectionId: string) {
	const page = await visitor(
		`/_ryu/connections/consent?connectionId=${encodeURIComponent(connectionId)}`,
		user,
		"GET",
		undefined,
		navigation
	);
	if (page.status !== 200) {
		throw new Error(`Consent page returned ${page.status}`);
	}
	const html = await page.text();
	const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? "";
	const decision = await visitor(
		"/_ryu/connections/consent",
		user,
		"POST",
		new URLSearchParams({ ticket, decision: "allow" }).toString(),
		{ ...navigation, "content-type": "application/x-www-form-urlencoded" }
	);
	if (decision.status !== 303) {
		throw new Error(`Consent decision returned ${decision.status}`);
	}
	return html;
}
async function listFor(user: string) {
	return visitorListSchema.parse(
		await (await visitor("/_ryu/connections", user)).json()
	).connections;
}
async function save(
	user: string,
	connections: SiteDataValue[],
	expectedRevision = store.get(site.id).revision
) {
	return admin("/connections", user, "PUT", { connections, expectedRevision });
}
const notion = {
	id: "notion",
	label: "Team notes",
	description: "Searches your Notion workspace.",
	toolId: "notion.search",
	readOnly: true,
};
const slack = {
	id: "slack",
	label: "My Slack",
	description: "Posts the summary to a channel you choose.",
	toolId: "slack.post_message",
	readOnly: false,
};

test("owners add, list, and audit owner bindings beside operator ones", async () => {
	const response = await save("owner", [slack]);
	expect(response.status).toBe(200);
	const saved = siteSchema.parse(await response.json());
	expect(saved.connections).toEqual([
		expect.objectContaining({ id: "slack", revision: 1 }),
	]);
	const managed = await (await admin("/connections", "owner")).json();
	expect(managed.available).toBe(true);
	expect(managed.connections[0]).toMatchObject({
		publicId: "owner.slack",
		allowed: true,
		agentId: "ryu",
		updatedBy: "owner",
	});
	expect(managed.operator).toEqual([
		{ id: "issues", label: "Operator issues", readOnly: true, selected: true },
	]);
	const listed = await listFor("reader");
	expect(listed.map(({ id, source }) => ({ id, source }))).toEqual([
		{ id: "issues", source: "operator" },
		{ id: "owner.slack", source: "owner" },
	]);
	expect(listed[1]?.description).toBe(slack.description);
	expect(listed[1]?.consented).toBe(false);
	const audit = z
		.array(z.object({ actor: z.string(), detail: z.string() }))
		.parse(
			store.db
				.query("SELECT actor, detail FROM site_audit WHERE site=? AND action=?")
				.all(site.id, CONNECTIONS_AUDIT_ACTION)
		);
	expect(audit.at(-1)?.actor).toBe("owner");
	expect(JSON.parse(audit.at(-1)?.detail ?? "{}").added).toEqual(["slack"]);
	// A stale revision never overwrites a newer save.
	expect((await save("owner", [], saved.revision - 1)).status).toBe(409);
});

test("only owners and editors manage bindings", async () => {
	expect((await admin("/connections", "reader")).status).toBe(403);
	expect((await save("reader", [])).status).toBe(403);
	expect((await save("outsider", [])).status).toBe(403);
	const response = await save("editor", [
		slack,
		{ ...slack, id: "notion", toolId: "notion.search", readOnly: true },
	]);
	expect(response.status).toBe(200);
	expect(store.get(site.id).connections?.map((entry) => entry.id)).toEqual([
		"slack",
		"notion",
	]);
	expect((await admin("/connections", "editor")).status).toBe(200);
});

test("invalid bindings are refused before they are stored", async () => {
	const before = store.get(site.id).revision;
	expect((await save("owner", [slack, slack])).status).toBe(400);
	expect(
		(await save("owner", [{ ...slack, toolId: "https://evil.example/x y" }]))
			.status
	).toBe(400);
	expect(
		(
			await save(
				"owner",
				Array.from({ length: 21 }, (_, index) => ({
					...slack,
					id: `tool${index}`,
				}))
			)
		).status
	).toBe(400);
	expect(
		(await save("owner", [{ ...slack, token: "secret" } as SiteDataValue]))
			.status
	).toBe(400);
	expect(store.get(site.id).revision).toBe(before);
	expect(
		(
			await admin(
				"/connections",
				"owner",
				"PUT",
				{ connections: [slack], expectedRevision: before },
				unavailable
			)
		).status
	).toBe(503);
});

test("operator policy overrides owner bindings when saved and afterwards", async () => {
	expect((await save("owner", [slack])).status).toBe(200);
	policy = policyWith({ tools: ["notion.*", "tracker.list"] });
	const refused = await save("owner", [{ ...slack, label: "Changed" }]);
	expect(refused.status).toBe(403);
	expect((await refused.json()).error.message).toContain("slack.post_message");
	expect(
		(
			await save("owner", [
				{ ...slack, id: "notion", toolId: "notion.search", readOnly: true },
			])
		).status
	).toBe(200);
	expect((await save("owner", [slack])).status).toBe(403);
	// The saved binding is hidden and unusable once the allowlist excludes it.
	policy = policyWith({ tools: ["tracker.*"] });
	expect((await listFor("reader")).map((entry) => entry.id)).toEqual([
		"issues",
	]);
	const managed = await (await admin("/connections", "owner")).json();
	expect(managed.connections[0].allowed).toBe(false);
	expect(
		(
			await visitor(
				"/_ryu/connections/consent?connectionId=owner.notion",
				"reader",
				"GET",
				undefined,
				navigation
			)
		).status
	).toBe(403);
	policy = policyWith({ enabled: false });
	expect((await save("owner", [slack])).status).toBe(403);
	const status = await fetch(
		`http://127.0.0.1:${server.admin.port}/api/sites/status`,
		{
			headers: {
				authorization: "Bearer test-only-app-token",
				"x-test-user": "owner",
			},
		}
	);
	expect((await status.json()).ownerConnectionsAvailable).toBe(false);
	expect((await listFor("reader")).map((entry) => entry.source)).toEqual([
		"operator",
	]);
	// Removing every binding stays possible while the switch is off.
	expect((await save("owner", [])).status).toBe(200);
	expect(store.get(site.id).connections).toEqual([]);
});

test("unchanged bindings pass through while the operator blocks others", async () => {
	expect((await save("owner", [slack, notion])).status).toBe(200);
	// With the switch off, one binding can still be removed on its own.
	policy = policyWith({ enabled: false });
	expect((await save("owner", [slack])).status).toBe(200);
	expect(store.get(site.id).connections?.map((entry) => entry.id)).toEqual([
		"slack",
	]);
	// Adding, changing, or asking for reconsent is still refused.
	expect((await save("owner", [slack, notion])).status).toBe(403);
	expect((await save("owner", [{ ...slack, label: "Renamed" }])).status).toBe(
		403
	);
	expect((await save("owner", [{ ...slack, reconsent: true }])).status).toBe(
		403
	);

	// Under an allowlist, a blocked saved binding never stalls edits to others.
	policy = policyWith();
	expect((await save("owner", [slack, notion])).status).toBe(200);
	policy = policyWith({ tools: ["notion.*"] });
	const edited = await save("owner", [
		slack,
		{ ...notion, label: "Team wiki" },
	]);
	expect(edited.status).toBe(200);
	const stored = store.get(site.id).connections ?? [];
	expect(stored.map(({ id, label }) => ({ id, label }))).toEqual([
		{ id: "slack", label: slack.label },
		{ id: "notion", label: "Team wiki" },
	]);
	expect(stored[0]?.revision).toBe(1);
	// The blocked binding cannot be changed, and stays hidden from visitors.
	expect((await save("owner", [{ ...slack, label: "X" }, notion])).status).toBe(
		403
	);
	expect((await listFor("reader")).map((entry) => entry.id)).toEqual([
		"issues",
		"owner.notion",
	]);
	expect(
		(await save("owner", [{ ...notion, label: "Team wiki" }])).status
	).toBe(200);
	expect(store.get(site.id).connections?.map((entry) => entry.id)).toEqual([
		"notion",
	]);
});

test("an unreadable operator policy turns owner bindings off without breaking status", async () => {
	expect((await save("owner", [notion])).status).toBe(200);
	policyUnreadable = true;
	const status = await fetch(
		`http://127.0.0.1:${server.admin.port}/api/sites/status`,
		{
			headers: {
				authorization: "Bearer test-only-app-token",
				"x-test-user": "owner",
			},
		}
	);
	expect(status.status).toBe(200);
	const body = await status.json();
	expect(body.connectionsAvailable).toBe(true);
	expect(body.ownerConnectionsAvailable).toBe(false);
	const managed = await admin("/connections", "owner");
	expect(managed.status).toBe(200);
	expect((await managed.json()).policy.enabled).toBe(false);
	expect((await listFor("reader")).map((entry) => entry.source)).toEqual([
		"operator",
	]);
	expect((await save("owner", [{ ...notion, label: "New" }])).status).toBe(403);
	expect((await save("owner", [])).status).toBe(200);
});

test("read access holds only for tools the operator confirms are read-only", async () => {
	const refused = await save("owner", [{ ...slack, readOnly: true }]);
	expect(refused.status).toBe(403);
	expect((await refused.json()).error.message).toContain("read-only");
	expect(store.get(site.id).connections ?? []).toEqual([]);

	expect((await save("owner", [notion])).status).toBe(200);
	const [, granted] = await listFor("reader");
	expect(granted?.readOnly).toBe(true);
	expect(await allow("reader", granted?.id ?? "")).toContain(
		"requests read access"
	);
	const invoke = {
		action: "invoke",
		connectionId: granted?.id ?? "",
		revision: granted?.revision ?? "",
		arguments: {},
	};
	expect(
		(await visitor("/_ryu/connections", "reader", "POST", invoke)).status
	).toBe(200);

	// Once the operator withdraws the vouch, the binding is treated as a
	// write: its revision changes, consent is asked again, and calls confirm.
	policy = policyWith({ readOnlyTools: [] });
	const [, demoted] = await listFor("reader");
	expect(demoted?.readOnly).toBe(false);
	expect(demoted?.revision).not.toBe(granted?.revision);
	expect(demoted?.consented).toBe(false);
	const managed = await (await admin("/connections", "owner")).json();
	expect(managed.connections[0]).toMatchObject({
		readOnly: true,
		effectiveReadOnly: false,
	});
	expect(await allow("reader", demoted?.id ?? "")).toContain(
		"requests read and write access"
	);
	const unconfirmed = await visitor("/_ryu/connections", "reader", "POST", {
		...invoke,
		revision: demoted?.revision,
	});
	expect((await unconfirmed.json()).error.code).toBe("confirmation_required");
	expect(calls).toHaveLength(1);
});

test("owner bindings run only as agents the operator allows", async () => {
	const helper = { ...slack, agentId: "helper" };
	const refused = await save("owner", [helper]);
	expect(refused.status).toBe(403);
	expect((await refused.json()).error.message).toContain("helper");
	policy = policyWith({ agents: ["ryu", "help*"] });
	expect((await save("owner", [helper])).status).toBe(200);
	expect((await listFor("reader")).map((entry) => entry.id)).toEqual([
		"issues",
		"owner.slack",
	]);
	policy = policyWith();
	expect((await listFor("reader")).map((entry) => entry.id)).toEqual([
		"issues",
	]);
	const managed = await (await admin("/connections", "owner")).json();
	expect(managed.connections[0].allowed).toBe(false);
	expect(managed.policy.agents).toEqual(["ryu"]);
});

test("the consent page shows the verified tool, agent, and who added it", async () => {
	expect(
		(
			await save("editor", [
				{ ...slack, label: "View <b>calendar</b>", description: "Harmless" },
			])
		).status
	).toBe(200);
	const [, owned] = await listFor("reader");
	const page = await allow("reader", owned?.id ?? "");
	expect(page).toContain("A Site editor added this connection.");
	expect(page).not.toContain("The Site owner added this connection.");
	expect(page).toContain("<code>slack.post_message</code>");
	expect(page).toContain("<code>ryu</code>");
	expect(page).toContain("Written by a Site editor");
	expect(page).toContain("View &lt;b&gt;calendar&lt;/b&gt;");
	expect(page).not.toContain("<b>calendar</b>");
});

test("visitors consent per revision, run as themselves, and confirm writes", async () => {
	expect((await save("owner", [slack])).status).toBe(200);
	const [, owned] = await listFor("reader");
	if (!owned) {
		throw new Error("owner binding missing");
	}
	const invoke = {
		action: "invoke",
		connectionId: owned.id,
		revision: owned.revision,
		arguments: { text: "hello" },
	};
	expect(
		(await visitor("/_ryu/connections", "reader", "POST", invoke)).status
	).toBe(403);
	const page = await allow("reader", owned.id);
	expect(page).toContain("The Site owner added this connection.");
	expect(page).toContain("Posts the summary to a channel you choose.");
	expect(page).toContain("read and write access");
	const unconfirmed = await visitor(
		"/_ryu/connections",
		"reader",
		"POST",
		invoke
	);
	expect((await unconfirmed.json()).error.code).toBe("confirmation_required");
	const confirmed = await visitor("/_ryu/connections", "reader", "POST", {
		...invoke,
		confirmWrite: true,
	});
	expect(await confirmed.json()).toEqual({
		result: { ran: "slack.post_message", as: "reader" },
	});
	// Another visitor's consent is never shared, including the owner's.
	expect(
		(
			await visitor("/_ryu/connections", "owner", "POST", {
				...invoke,
				confirmWrite: true,
			})
		).status
	).toBe(403);
	expect(calls).toEqual([
		{ user: "reader", tool: "slack.post_message", agent: "ryu" },
	]);

	// Changing the wording bumps the revision and invalidates every consent.
	expect(
		(await save("owner", [{ ...slack, label: "Team Slack" }])).status
	).toBe(200);
	expect(store.get(site.id).connections?.[0]?.revision).toBe(2);
	const stale = await visitor("/_ryu/connections", "reader", "POST", {
		...invoke,
		confirmWrite: true,
	});
	expect(stale.status).toBe(409);
	const [, renamed] = await listFor("reader");
	expect(renamed?.consented).toBe(false);
	const fresh = await visitor("/_ryu/connections", "reader", "POST", {
		...invoke,
		revision: renamed?.revision,
		confirmWrite: true,
	});
	expect((await fresh.json()).error.code).toBe("consent_required");

	// Saving unchanged keeps the revision; an explicit reconsent bumps it.
	await allow("reader", owned.id);
	expect(
		(await save("owner", [{ ...slack, label: "Team Slack" }])).status
	).toBe(200);
	expect((await listFor("reader"))[1]?.consented).toBe(true);
	expect(
		(await save("owner", [{ ...slack, label: "Team Slack", reconsent: true }]))
			.status
	).toBe(200);
	expect(store.get(site.id).connections?.[0]?.revision).toBe(3);
	expect((await listFor("reader"))[1]?.consented).toBe(false);
});

test("connected tools require workspace access and a daily per-visitor share", async () => {
	expect((await save("owner", [notion])).status).toBe(200);
	expect((await visitor("/_ryu/connections", "outsider")).status).toBe(403);
	// Anonymous visitors never reach a workspace Site.
	expect((await visitor("/_ryu/connections", "")).status).toBe(403);
	const [, owned] = await listFor("reader");
	await allow("reader", owned?.id ?? "");
	const day = new Date().toISOString().slice(0, 10);
	store.db
		.query("INSERT OR REPLACE INTO operation_usage VALUES(?,?,?,?)")
		.run(
			site.id,
			day,
			`connection:${store.visitorQuotaKey(site.id, day, "user:reader")}`,
			200
		);
	const limited = await visitor("/_ryu/connections", "reader", "POST", {
		action: "invoke",
		connectionId: owned?.id ?? "",
		revision: owned?.revision ?? "",
		arguments: {},
	});
	expect(limited.status).toBe(429);
	expect(calls).toEqual([]);
});

test("removing a binding drops its consents", async () => {
	expect((await save("owner", [notion])).status).toBe(200);
	const [, owned] = await listFor("reader");
	await allow("reader", owned?.id ?? "");
	expect((await save("owner", [])).status).toBe(200);
	expect(
		store.db
			.query("SELECT 1 FROM connection_consents WHERE site=? AND connection=?")
			.get(site.id, "owner.notion")
	).toBeNull();
	expect((await listFor("reader")).map((entry) => entry.id)).toEqual([
		"issues",
	]);
});

test("policy matching, ID shadowing, and stored Site migration", () => {
	expect(
		ownerConnectionToolAllowed(policyWith({ tools: ["slack.*"] }), "slack.x")
	).toBe(true);
	expect(
		ownerConnectionToolAllowed(policyWith({ tools: ["slack.*"] }), "slackx")
	).toBe(false);
	expect(
		ownerConnectionToolAllowed(policyWith({ enabled: false }), "slack.x")
	).toBe(false);
	const current = store.get(site.id);
	const { next } = applyOwnerConnections({
		current: [],
		requested: [
			{
				id: "issues",
				label: "Mine",
				description: "",
				toolId: "tracker.list",
				agentId: "ryu",
				readOnly: true,
				reconsent: false,
			},
		],
		policy: policyWith(),
		actor: "owner",
		now: "2026-01-01T00:00:00.000Z",
	});
	const shadowing = approvedConnection.parse({
		...operator,
		id: "owner.issues",
	});
	const resolved = resolveSiteConnections({
		site: { ...current, connections: next } satisfies RuntimeSite,
		operator: [shadowing],
		operatorSelected: [],
		policy: policyWith(),
	});
	expect(resolved).toEqual([]);
	const { connections: _dropped, ...legacy } = current;
	expect(readStoredSite(JSON.stringify(legacy)).connections).toEqual([]);
});

test("runtime.json owner connection policy defaults on and validates its allowlist", () => {
	expect(runtimeConfigSchema.parse({}).ownerConnections).toBe(true);
	expect(runtimeConfigSchema.parse({}).ownerConnectionTools).toBeUndefined();
	expect(
		runtimeConfigSchema.parse({
			ownerConnections: false,
			ownerConnectionTools: ["slack.*", "notion.search"],
		}).ownerConnectionTools
	).toEqual(["slack.*", "notion.search"]);
	expect(
		runtimeConfigSchema.safeParse({ ownerConnectionTools: ["*"] }).success
	).toBe(false);
	expect(runtimeConfigSchema.parse({}).ownerConnectionAgents).toEqual(["ryu"]);
	expect(runtimeConfigSchema.parse({}).ownerConnectionReadOnlyTools).toEqual(
		[]
	);
	expect(
		runtimeConfigSchema.safeParse({ ownerConnectionAgents: ["*"] }).success
	).toBe(false);
	expect(
		runtimeConfigSchema.safeParse({ ownerConnectionReadOnlyTools: ["a b"] })
			.success
	).toBe(false);
	expect(
		runtimeConfigSchema.safeParse({ ownerConnectionTools: ["a b"] }).success
	).toBe(false);
});
