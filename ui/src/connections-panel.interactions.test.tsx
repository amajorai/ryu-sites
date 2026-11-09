import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { type RuntimeSite, siteSettings } from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { SiteConnectionsPanel } = await import("./connections-panel.tsx");

interface Request {
	body?: SiteDataValue;
	method: string;
	path: string;
}
const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => {
			root.unmount();
			await flush();
		});
		container.remove();
	}
	Reflect.set(window, "ryu", undefined);
});

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const baseSite: RuntimeSite = {
	id: "site-1",
	name: "Site",
	ownerId: "owner",
	access: "owner",
	aliases: [],
	connections: [],
	createdAt: "2026-10-05T00:00:00Z",
	updatedAt: "2026-10-05T00:00:00Z",
	deploymentId: null,
	domains: [],
	hasPublished: false,
	prompt: "",
	revision: 4,
	schemaVersion: 1,
	settings: siteSettings.parse({ mode: "connected" }),
	slug: "site-one",
	template: "website",
	versions: [],
};
const slack = {
	id: "slack",
	label: "Team Slack",
	description: "Posts to a channel you choose.",
	toolId: "slack.post_message",
	agentId: "ryu",
	readOnly: false,
	revision: 2,
	updatedAt: "2026-10-05T00:00:00Z",
	updatedBy: "owner",
};
function statusWith(patch: Record<string, SiteDataValue> = {}): SiteDataValue {
	return {
		available: true,
		policy: {
			enabled: true,
			tools: null,
			agents: ["ryu"],
			readOnlyTools: ["notion.*"],
		},
		connections: [],
		operator: [],
		...patch,
	};
}

function bridge(responses: ((request: Request) => unknown)[]) {
	const calls: Request[] = [];
	Reflect.set(window, "ryu", {
		app: {
			request: async (input: Request) => {
				calls.push(input);
				const next = responses.shift();
				if (!next) {
					throw new Error(`Unexpected request ${input.method} ${input.path}`);
				}
				return next(input);
			},
		},
	});
	return calls;
}

async function render(site = baseSite, replaced: RuntimeSite[] = []) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => {
		root.render(
			<I18nProvider autoLocalizeDom={false}>
				<SiteConnectionsPanel
					busy={false}
					replace={(next) => replaced.push(next)}
					run={async (work) => work()}
					site={site}
				/>
			</I18nProvider>
		);
		await flush();
	});
	return container;
}

function button(label: string) {
	const found = [...document.body.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}`);
	}
	return found;
}
async function click(label: string) {
	const found = button(label);
	await act(async () => {
		found.click();
		await flush();
	});
}
async function type(label: string, value: string) {
	const field = document.body.querySelector<
		HTMLInputElement | HTMLTextAreaElement
	>(`[aria-label="${label}"]`);
	if (!field) {
		throw new Error(`Missing field ${label}`);
	}
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			field,
			value
		);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();
	});
}

test("lists owner bindings with access, policy state and operator connections", async () => {
	bridge([
		() =>
			statusWith({
				connections: [{ ...slack, publicId: "owner.slack", allowed: false }],
				operator: [
					{ id: "issues", label: "Issues", readOnly: true, selected: true },
				],
			}),
	]);
	const container = await render();
	expect(container.textContent).toContain("Team Slack");
	expect(container.textContent).toContain("slack.post_message");
	expect(container.textContent).toContain("Read and write access");
	expect(container.textContent).toContain("Blocked by operator policy");
	expect(container.textContent).toContain("Operator-approved connections");
	expect(container.textContent).toContain("Selected");
});

test("an owner adds a connection with the current revision", async () => {
	const saved = { ...baseSite, revision: 5 };
	const calls = bridge([() => statusWith(), () => saved]);
	const replaced: RuntimeSite[] = [];
	const container = await render(baseSite, replaced);
	expect(container.textContent).toContain("No owner connections");
	await click("Add a connection");
	await type("ID", "notes");
	await type("Label", "My notes");
	await type("Connection description", "Searches your notes.");
	await type("Core tool ID", "notion.search");
	await click("Add connection");
	expect(calls.at(-1)).toEqual({
		method: "PUT",
		path: "/projects/site-1/connections",
		body: {
			connections: [
				{
					id: "notes",
					label: "My notes",
					description: "Searches your notes.",
					toolId: "notion.search",
					agentId: "ryu",
					readOnly: true,
					reconsent: false,
				},
			],
			expectedRevision: 4,
		},
	});
	expect(replaced).toEqual([saved]);
	expect(container.textContent).toContain("Connection added.");
});

test("tools the operator has not confirmed read-only are bound with write access", async () => {
	const calls = bridge([() => statusWith(), () => baseSite]);
	const container = await render();
	await click("Add a connection");
	await type("ID", "post");
	await type("Label", "Post");
	await type("Core tool ID", "slack.post_message");
	expect(container.textContent).toContain(
		"has not confirmed this tool is read-only"
	);
	await click("Add connection");
	expect(calls.at(-1)?.body).toMatchObject({
		connections: [{ toolId: "slack.post_message", readOnly: false }],
	});
});

test("saved bindings show the access the operator actually enforces", async () => {
	bridge([
		() =>
			statusWith({
				connections: [
					{
						...slack,
						readOnly: true,
						effectiveReadOnly: false,
						publicId: "owner.slack",
						allowed: true,
					},
				],
			}),
	]);
	const container = await render();
	expect(container.textContent).toContain("Read and write access");
	expect(container.textContent).not.toContain("Read access");
});

test("invalid drafts and refused saves show an error without replacing the Site", async () => {
	bridge([
		() => statusWith(),
		() => {
			throw new Error('Your operator has not approved the tool "x.y"');
		},
	]);
	const replaced: RuntimeSite[] = [];
	const container = await render(baseSite, replaced);
	await click("Add a connection");
	await type("ID", "Bad ID");
	await click("Add connection");
	expect(container.textContent).toContain("Use a lowercase ID");
	await type("ID", "tool");
	await type("Label", "Tool");
	await type("Core tool ID", "x.y");
	await click("Add connection");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"has not approved"
	);
	expect(replaced).toEqual([]);
});

test("removing sends the remaining bindings, and editing keeps the ID", async () => {
	const site = { ...baseSite, connections: [slack] };
	const calls = bridge([
		() =>
			statusWith({
				connections: [{ ...slack, publicId: "owner.slack", allowed: true }],
			}),
		() => ({ ...site, connections: [], revision: 5 }),
	]);
	await render(site);
	await click("Edit");
	const id = document.body.querySelector<HTMLInputElement>('[aria-label="ID"]');
	expect(id?.disabled).toBe(true);
	await click("Cancel");
	await click("Remove");
	expect(calls.at(-1)?.body).toEqual({ connections: [], expectedRevision: 4 });
});

test("disabled policy, unavailable service, and load errors explain themselves", async () => {
	bridge([() => statusWith({ policy: { enabled: false, tools: null } })]);
	const disabled = await render();
	expect(disabled.textContent).toContain("Owner connections are off");
	expect(() => button("Add a connection")).toThrow();
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => {
			root.unmount();
			await flush();
		});
		container.remove();
	}

	bridge([
		() => {
			throw new Error("Connections are unavailable right now");
		},
		() => statusWith({ available: false }),
	]);
	const failed = await render();
	expect(failed.querySelector('[role="alert"]')?.textContent).toBe(
		"Connections are unavailable right now"
	);
	await click("Try again");
	expect(failed.textContent).toContain("Connected tools need platform sign-in");
	expect(() => button("Add a connection")).toThrow();
});
