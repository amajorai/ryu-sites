import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { type RuntimeSite, siteSettings } from "../../sidecar/src/contracts.ts";
import type { ServiceStatus } from "./schemas.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SiteSettingsPanel } = await import("./settings.tsx");

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => {
			root.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		container.remove();
	}
});

function status(patch: Partial<ServiceStatus>): ServiceStatus {
	return {
		agentAvailable: false,
		answersAvailable: false,
		baseDomain: "localhost",
		connectionsAvailable: false,
		databaseAvailable: false,
		domainsAvailable: false,
		identityAvailable: false,
		mcpAvailable: false,
		mcpUiAvailable: false,
		pluginInstallAvailable: false,
		publicEnabled: true,
		retrievalAvailable: false,
		scannerAvailable: true,
		visitorPort: 8022,
		...patch,
	};
}

function site(audience: RuntimeSite["settings"]["audience"]): RuntimeSite {
	return {
		id: "site-1",
		name: "Site",
		ownerId: "owner",
		access: "owner",
		aliases: [],
		createdAt: "2026-10-05T00:00:00Z",
		updatedAt: "2026-10-05T00:00:00Z",
		deploymentId: null,
		domains: [],
		hasPublished: false,
		prompt: "",
		revision: 1,
		schemaVersion: 1,
		settings: siteSettings.parse({ audience }),
		slug: "site-one",
		template: "website",
		versions: [],
	};
}

async function render(selected: RuntimeSite, serviceStatus: ServiceStatus) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => {
		root.render(
			<SiteSettingsPanel
				busy={false}
				onDelete={() => undefined}
				replace={() => undefined}
				run={async (work) => work()}
				site={selected}
				status={serviceStatus}
			/>
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container;
}

async function typeDomain(container: HTMLElement, value: string) {
	const input = container.querySelector<HTMLInputElement>(
		'input[aria-label="Custom domain"]'
	);
	if (!input) {
		throw new Error("Missing the Custom domain field");
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function addDomain(container: HTMLElement) {
	const found = [...container.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === "Add domain"
	);
	if (!found) {
		throw new Error("Missing the Add domain button");
	}
	return found;
}

test("custom domains are disclosed as unavailable without an edge provider", async () => {
	const unavailable = await render(site("private"), status({}));
	await typeDomain(unavailable, "help.example.com");
	expect(addDomain(unavailable).disabled).toBe(true);
	expect(unavailable.textContent).toContain(
		"No edge or TLS provider is configured on this node"
	);
	const available = await render(
		site("private"),
		status({ domainsAvailable: true })
	);
	await typeDomain(available, "help.example.com");
	expect(addDomain(available).disabled).toBe(false);
	expect(available.textContent).not.toContain("No edge or TLS provider");
});

test("a public Site explains its suspension when public publishing is off", async () => {
	const container = await render(
		site("public"),
		status({ publicEnabled: false })
	);
	expect(container.textContent).toContain("public access is suspended");
});

test("shared visitor data is off by default and needs a connected database and identity", async () => {
	const blocked = await render(
		site("public"),
		status({ identityAvailable: true })
	);
	const blockedInput =
		blocked.querySelector<HTMLInputElement>("input#shared-data");
	expect(blockedInput?.checked).toBe(false);
	expect(blockedInput?.disabled).toBe(true);
	expect(blocked.textContent).toContain(
		"Shared visitor data needs the Connected to Ryu runtime"
	);
	const connected = site("public");
	connected.settings = siteSettings.parse({
		audience: "public",
		mode: "connected",
		database: { databaseId: "db", spaceId: "local" },
	});
	const ready = await render(connected, status({ identityAvailable: true }));
	const readyInput = ready.querySelector<HTMLInputElement>("input#shared-data");
	expect(readyInput?.disabled).toBe(false);
	expect(
		ready.querySelector('[aria-label="Who can add shared records"]')
	).toBeNull();
	await act(async () => {
		readyInput?.parentElement
			?.querySelector<HTMLElement>('[role="switch"]')
			?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(readyInput?.checked).toBe(true);
	expect(
		ready.querySelector('[aria-label="Who can add shared records"]')
			?.textContent
	).toContain("Signed-in visitors");
});

test("general page AI is chosen explicitly and keeps owner instructions", async () => {
	const grounded = site("public");
	grounded.settings = siteSettings.parse({
		audience: "public",
		mode: "connected",
		ai: true,
	});
	const unavailable = await render(
		grounded,
		status({ answersAvailable: true })
	);
	expect(
		unavailable.querySelector('[aria-label="AI mode"]')?.textContent
	).toContain("Grounded answers");
	expect(unavailable.textContent).toContain(
		"General page AI needs a Ryu model connected to this node."
	);
	expect(
		unavailable.querySelector('[aria-label="Owner AI instructions"]')
	).toBeNull();
	const general = site("public");
	general.settings = siteSettings.parse({
		audience: "public",
		mode: "connected",
		ai: true,
		aiMode: "general",
		aiSystemPrompt: "Answer briefly.",
	});
	const ready = await render(general, status({ completionsAvailable: true }));
	expect(ready.querySelector('[aria-label="AI mode"]')?.textContent).toContain(
		"General page AI"
	);
	expect(
		ready.querySelector<HTMLTextAreaElement>(
			'[aria-label="Owner AI instructions"]'
		)?.value
	).toBe("Answer briefly.");
	const anonymous = ready.querySelector<HTMLInputElement>("input#ai-anonymous");
	expect(anonymous?.checked).toBe(false);
	expect(ready.textContent).toContain("Off by default.");
});
