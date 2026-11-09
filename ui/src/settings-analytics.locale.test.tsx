import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { type RuntimeSite, siteSettings } from "../../sidecar/src/contracts.ts";
import { Analytics } from "./settings-analytics.tsx";

// The date-range trigger is an ICU plural keyed on a number, so each locale
// picks its own noun form. The flat "Last {days} days" gave Arabic the
// singular noun for the 7-day default ("آخر 7 يوم").

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

const RANGE = "{days, plural, one {Last # day} other {Last # days}}";

function render(locale: string, overlay: Record<string, string> = {}): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
			manageDocument={false}
			overlays={{ [locale]: overlay }}
		>
			<Analytics site={site} />
		</I18nProvider>
	);
}

test("the default range reads 'Last 7 days' in English", () => {
	expect(render("en")).toContain("Last 7 days");
});

test("Arabic picks the few form for the 7-day default", () => {
	const markup = render("ar", {
		[RANGE]:
			"{days, plural, zero {اليوم} one {آخر يوم} two {آخر يومين} few {آخر # أيام} many {آخر # يومًا} other {آخر # يوم}}",
	});
	expect(markup).toContain("آخر 7 أيام");
});
