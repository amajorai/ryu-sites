/**
 * Visitor-facing copy the Sites sidecar adds to a published page: the
 * "Powered by Ryu" badge on free plans. A deployed page is the author's own
 * HTML with no localizer, so the badge is translated here, in the visitor's
 * language, before it is stamped in. `scripts/sync-respondent-catalogs.mjs`
 * reads the `tl("…")` literals below into `respondent-catalog.generated.json`.
 */
import type { PoweredByRyuCopy } from "@ryu/sidecar-runtime/branding";
import { negotiateRespondentLocale } from "./respondent-locale.ts";

/** The badge copy for a visitor's `Accept-Language`. */
export function poweredByRyuCopy(
	acceptLanguage: string | null | undefined
): PoweredByRyuCopy {
	const t = negotiateRespondentLocale(acceptLanguage);
	return {
		ariaLabel: t.tl("Powered by Ryu — make your own"),
		dir: t.dir,
		label: t.tl("Powered by <b>Ryu</b>"),
	};
}
