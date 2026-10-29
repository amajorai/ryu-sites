import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import {
	type RemixableSite,
	type RuntimeSite,
	siteSettings,
} from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
	RemixSiteDialog,
	SITE_TEMPLATES,
	SitesGallery,
	provenanceLabel,
	slugFrom,
} = await import("./gallery.tsx");
const { SiteSettingsPanel } = await import("./settings.tsx");

interface BridgeRequest {
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
function bridge(respond: (request: BridgeRequest) => unknown) {
	const calls: BridgeRequest[] = [];
	Reflect.set(window, "ryu", {
		app: {
			request: async (request: BridgeRequest) => {
				calls.push(request);
				return await respond(request);
			},
		},
	});
	return calls;
}
async function render(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => {
		root.render(node);
		await flush();
	});
	return container;
}
function button(scope: ParentNode, label: string) {
	const found = [...scope.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}`);
	}
	return found;
}
async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
		await flush();
	});
}

const remixable: RemixableSite = {
	id: "site-shared",
	name: "Team handbook",
	slug: "team-handbook",
	template: "help-center",
	deploymentId: "version-1",
	updatedAt: "2026-10-05T00:00:00Z",
	access: "viewer",
};
function site(patch: Partial<RuntimeSite> = {}): RuntimeSite {
	return {
		id: "site-new",
		name: "Team handbook remix",
		ownerId: "me",
		access: "owner",
		aliases: [],
		connections: [],
		createdAt: "2026-10-05T00:00:00Z",
		updatedAt: "2026-10-05T00:00:00Z",
		deploymentId: null,
		domains: [],
		hasPublished: false,
		prompt: "",
		revision: 0,
		schemaVersion: 1,
		settings: siteSettings.parse({}),
		slug: "team-handbook-remix",
		template: "help-center",
		versions: [],
		...patch,
	};
}

test("the Gallery shows every template as a script-less preview and remixable Sites", async () => {
	const calls = bridge(() => [remixable]);
	const remixes: unknown[] = [];
	const templates: string[] = [];
	const container = await render(
		<SitesGallery
			busy={false}
			onRemix={(source) => remixes.push(source)}
			onUseTemplate={(template) => templates.push(template)}
		/>
	);
	expect(calls).toEqual([
		{ path: "/projects?scope=remixable", method: "GET", body: undefined },
	]);
	const frames = [...container.querySelectorAll("iframe")];
	expect(frames).toHaveLength(SITE_TEMPLATES.length);
	// An empty sandbox runs no starter script and reaches no Ryu runtime.
	for (const frame of frames) {
		expect(frame.getAttribute("sandbox")).toBe("");
	}
	expect(container.textContent).toContain("Team handbook");
	await click(button(container, "Remix"));
	expect(remixes).toEqual([
		{ id: "site-shared", kind: "remix", name: "Team handbook" },
	]);
	await click(button(container, "Use template"));
	expect(templates).toEqual([SITE_TEMPLATES[0]?.id ?? ""]);
});

test("the Gallery offers a Site the caller edits as a duplicate of its latest version", async () => {
	bridge(() => [{ ...remixable, access: "editor" }]);
	const remixes: unknown[] = [];
	const container = await render(
		<SitesGallery
			busy={false}
			onRemix={(source) => remixes.push(source)}
			onUseTemplate={() => undefined}
		/>
	);
	expect(container.textContent).toContain("You edit");
	await click(button(container, "Duplicate"));
	expect(remixes).toEqual([
		{ id: "site-shared", kind: "duplicate", name: "Team handbook" },
	]);
});

test("the Gallery explains an empty list and keeps a failed load retryable", async () => {
	let fail = true;
	bridge(() => {
		if (fail) {
			throw new Error("Sites service unavailable");
		}
		return [];
	});
	const container = await render(
		<SitesGallery
			busy={false}
			onRemix={() => undefined}
			onUseTemplate={() => undefined}
		/>
	);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"Sites service unavailable"
	);
	fail = false;
	await click(button(container, "Retry"));
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(container.textContent).toContain("No remixable sites");
});

test("remixing posts the new name and opens the created Site", async () => {
	const calls = bridge(() => site({ remixedFrom: null }));
	const created: RuntimeSite[] = [];
	await render(
		<RemixSiteDialog
			busy={false}
			onCreated={async (next) => {
				created.push(next);
			}}
			onOpenChange={() => undefined}
			run={async (work) => work()}
			source={{ id: "site-shared", kind: "remix", name: "Team handbook" }}
		/>
	);
	expect(document.body.textContent).toContain("Remix site");
	await click(button(document.body, "Remix site"));
	expect(calls).toEqual([
		{
			path: "/projects/site-shared/remix",
			method: "POST",
			body: { name: "Team handbook remix", slug: "team-handbook-remix" },
		},
	]);
	expect(created.map((item) => item.id)).toEqual(["site-new"]);
});

test("a refused remix stays in the dialog with the service's reason", async () => {
	bridge(() => {
		throw new Error("The owner has not allowed remixing this Site");
	});
	const created: RuntimeSite[] = [];
	await render(
		<RemixSiteDialog
			busy={false}
			onCreated={async (next) => {
				created.push(next);
			}}
			onOpenChange={() => undefined}
			run={async (work) => work()}
			source={{ id: "site-owned", kind: "duplicate", name: "Docs" }}
		/>
	);
	await click(button(document.body, "Duplicate site"));
	expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
		"The owner has not allowed remixing this Site"
	);
	expect(created).toEqual([]);
});

test("provenance and suggested URL names", () => {
	expect(provenanceLabel(site())).toBeNull();
	expect(
		provenanceLabel(
			site({
				remixedFrom: { name: "Docs", siteId: "site-1", versionId: "v1" },
			})
		)
	).toBe("Remixed from Docs");
	expect(slugFrom("2026 Team Handbook!")).toBe("team-handbook");
	expect(slugFrom("A".repeat(80))).toHaveLength(48);
});

test("owners opt in to remixing in Settings; it starts off", async () => {
	const container = await render(
		<SiteSettingsPanel
			busy={false}
			onDelete={() => undefined}
			replace={() => undefined}
			run={async (work) => work()}
			site={site()}
			status={{
				agentAvailable: false,
				answersAvailable: false,
				baseDomain: "localhost",
				connectionsAvailable: false,
				databaseAvailable: false,
				identityAvailable: false,
				mcpAvailable: false,
				mcpUiAvailable: false,
				pluginInstallAvailable: false,
				publicEnabled: true,
				retrievalAvailable: false,
				scannerAvailable: true,
				visitorPort: 8022,
			}}
		/>
	);
	const toggle = container.querySelector<HTMLInputElement>("input#allow-remix");
	expect(toggle?.checked).toBe(false);
	expect(toggle?.disabled).toBe(false);
	expect(container.textContent).toContain("Allow remixing");
	expect(container.textContent).toContain(
		"Sharing, editors, domains, connections, data and analytics are never copied"
	);
});
