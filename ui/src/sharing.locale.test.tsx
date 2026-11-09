import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { type RuntimeSite, siteSettings } from "../../sidecar/src/contracts.ts";
import type { ServiceStatus } from "./schemas.ts";

// The closed role and audience triggers must show the translated option
// label. A bare <SelectValue /> without `items` printed the raw value
// ("viewer", "private") in every locale.

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { SiteSharingDialog } = await import("./sharing.tsx");

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

function shippedCatalog(locale: string): Record<string, string> {
	const path = fileURLToPath(
		new URL(`../../../../packages/i18n/locales/${locale}.json`, import.meta.url)
	);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

const status: ServiceStatus = {
	agentAvailable: false,
	answersAvailable: false,
	baseDomain: "localhost",
	connectionsAvailable: false,
	databaseAvailable: false,
	domainsAvailable: false,
	identityAvailable: true,
	mcpAvailable: false,
	mcpUiAvailable: false,
	pluginInstallAvailable: false,
	publicEnabled: true,
	retrievalAvailable: false,
	scannerAvailable: true,
	visitorPort: 8022,
};

const site: RuntimeSite = {
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
	settings: siteSettings.parse({ audience: "private" }),
	slug: "site-one",
	template: "website",
	versions: [],
};

async function render(locale: string) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
				manageDocument={false}
				overlays={{ [locale]: shippedCatalog(locale) }}
			>
				<SiteSharingDialog
					busy={false}
					onOpenChange={() => undefined}
					open
					replace={() => undefined}
					run={async (work) => work()}
					site={site}
					status={status}
				/>
			</I18nProvider>
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function trigger(label: string): string {
	const element = document.querySelector(`[aria-label="${label}"]`);
	if (!element) {
		throw new Error(`no trigger labelled ${label}`);
	}
	return element.textContent ?? "";
}

test("the role and audience triggers show German labels", async () => {
	const de = shippedCatalog("de");
	expect(de.Viewer).toBeTruthy();
	expect(de["Just me"]).toBeTruthy();
	await render("de");
	const role = trigger(de["Access role"] ?? "Access role");
	const audience = trigger(de["Who can visit"] ?? "Who can visit");
	expect(role).toContain(de.Viewer ?? "");
	expect(role).not.toContain("viewer");
	expect(audience).toContain(de["Just me"] ?? "");
	expect(audience).not.toContain("private");
});

test("the triggers show English labels in English", async () => {
	await render("en");
	expect(trigger("Access role")).toContain("Viewer");
	expect(trigger("Who can visit")).toContain("Just me");
});
