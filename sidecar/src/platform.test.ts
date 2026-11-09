import { expect, test } from "bun:test";
import { createSitesRetrieval } from "./platform.ts";

test("Sites searches only the bound Space through the canonical host search operation", async () => {
	const calls: unknown[] = [];
	const fetchImpl = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			calls.push(JSON.parse(String(init?.body)));
			return Response.json({
				result: {
					space_id: "approved",
					matches: [
						{
							chunk_id: "citation",
							content: "A grounded passage",
							distance: 0,
							document_id: "private-id",
							token: "never-export",
						},
					],
				},
			});
		},
		{ preconnect: fetch.preconnect }
	);
	const platform = createSitesRetrieval({
		corePort: 7980,
		token: "extension-token",
		bindings: { siteA: ["approved"] },
		fetchImpl,
	});
	expect(await platform.retrieve("siteA", "approved", "question")).toEqual([
		{ id: "citation", text: "A grounded passage", score: 1 },
	]);
	expect(calls).toEqual([
		{
			method: "spaces.search",
			args: { space_id: "approved", query: "question", limit: 8 },
		},
	]);
	await expect(
		platform.retrieve("siteB", "approved", "question")
	).rejects.toThrow("not approved");
	await expect(
		platform.retrieve("siteA", "another-space", "question")
	).rejects.toThrow("not approved");
	expect(calls).toHaveLength(1);
});

function coreHost(requiresIdentity: boolean) {
	const forwarded: Array<string | null> = [];
	const fetchImpl = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			forwarded.push(new Headers(init?.headers).get("x-ryu-user-jwt"));
			return Response.json({ result: { principal: null, requiresIdentity } });
		},
		{ preconnect: fetch.preconnect }
	);
	return {
		forwarded,
		platform: createSitesRetrieval({
			corePort: 7980,
			token: "extension-token",
			bindings: {},
			fetchImpl,
		}),
	};
}

// The header set Core's ext-proxy sends after verifying the caller's JWT: the
// JWT itself is stripped and only the verified user, org and email are stamped.
const coreHop = (caller: Record<string, string> = {}) =>
	new Request("http://127.0.0.1:8021/api/sites/projects", {
		headers: {
			authorization: "Bearer extension-token",
			"x-ryu-caller-principal-proof": "core-proof",
			...caller,
		},
	});

test("management identity on an org node comes from Core's verified caller headers", async () => {
	const { platform, forwarded } = coreHost(true);
	expect(
		await platform.managementIdentity(
			coreHop({
				"x-ryu-caller-user-id": "member-a",
				"x-ryu-caller-org-id": "org-1",
			})
		)
	).toEqual({ id: "member-a", email: "", workspaceIds: ["org-1"] });
	expect(await platform.managementIdentity(coreHop())).toBeNull();
	await expect(
		platform.managementIdentity(
			coreHop({ "x-ryu-caller-user-id": "a".repeat(257) })
		)
	).rejects.toThrow("Invalid caller identity");
	expect(forwarded).toEqual([null, null]);
});

test("management identity carries Core's verified email for named grants", async () => {
	const { platform } = coreHost(true);
	expect(
		await platform.managementIdentity(
			coreHop({
				"x-ryu-caller-user-id": "member-b",
				"x-ryu-caller-org-id": "org-1",
				"x-ryu-caller-email": " Editor@Example.com ",
			})
		)
	).toEqual({
		id: "member-b",
		email: "editor@example.com",
		workspaceIds: ["org-1"],
	});
	// An email alone never admits anyone on an org node.
	expect(
		await platform.managementIdentity(
			coreHop({ "x-ryu-caller-email": "editor@example.com" })
		)
	).toBeNull();
	for (const email of [
		`${"a".repeat(250)}@example.com`,
		"a\u0007@example.com",
	]) {
		await expect(
			platform.managementIdentity(
				coreHop({
					"x-ryu-caller-user-id": "member-b",
					"x-ryu-caller-email": email,
				})
			)
		).rejects.toThrow("Invalid caller identity");
	}
});

test("management identity on an unbound node keeps the node owner", async () => {
	const { platform } = coreHost(false);
	expect(await platform.managementIdentity(coreHop())).toEqual({
		id: "node-owner",
		email: "",
		workspaceIds: [],
	});
	expect(
		await platform.managementIdentity(
			coreHop({
				"x-ryu-caller-user-id": "cloud-user",
				"x-ryu-caller-org-id": "org-1",
			})
		)
	).toEqual({ id: "node-owner", email: "", workspaceIds: ["org-1"] });
});

test("general completion uses the host model path and never invents text on failure", async () => {
	const calls: unknown[] = [];
	let status = 200;
	const fetchImpl = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			calls.push(JSON.parse(String(init?.body)));
			return status === 200
				? Response.json({ result: "A summary" })
				: new Response("unavailable", { status });
		},
		{ preconnect: fetch.preconnect }
	);
	const platform = createSitesRetrieval({
		corePort: 7980,
		token: "extension-token",
		bindings: {},
		fetchImpl,
	});
	expect(
		await platform.complete({ system: "Rules", prompt: "Summarize" })
	).toBe("A summary");
	expect(calls).toEqual([
		{
			method: "model.complete",
			args: { system: "Rules", prompt: "Summarize" },
		},
	]);
	status = 503;
	await expect(
		platform.complete({ system: "Rules", prompt: "Summarize" })
	).rejects.toThrow("unavailable");
});
