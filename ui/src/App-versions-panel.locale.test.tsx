import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { type RuntimeSite, siteSettings } from "../../sidecar/src/contracts.ts";

// A saved version's size used to be hand-built as `Math.ceil(n / 1024) KB`:
// the English unit in every locale, no MB switch and no digit grouping.

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { SiteVersionsPanel } = await import("./App-versions-panel.tsx");

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
	versions: [
		{
			bytes: 1_572_864,
			commit: null,
			createdAt: "2026-10-05T00:00:00Z",
			id: "v1",
			message: "First",
		},
	],
};

async function renderText(locale: string): Promise<string> {
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
			>
				<SiteVersionsPanel
					busy={false}
					replace={() => undefined}
					run={async (work) => work()}
					setHtml={() => undefined}
					setNotice={() => undefined}
					setPanel={() => undefined}
					site={site}
					status={null}
				/>
			</I18nProvider>
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container.textContent ?? "";
}

test("a version's size uses the locale's number and unit", async () => {
	const text = await renderText("de");
	expect(text).toMatch(/1,5\s?MB/u);
	expect(text).not.toContain("1536 KB");
});

test("a version's size reads in megabytes in English", async () => {
	const text = await renderText("en");
	expect(text).toContain("1.5 MB");
	expect(text).not.toContain("1536 KB");
});
