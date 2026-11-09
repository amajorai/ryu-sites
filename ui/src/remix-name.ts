/**
 * The duplicate/remix dialog's pre-filled name and slug. The name is a whole
 * translated message ("Mein Shop Kopie"); the slug stays ASCII and keeps the
 * English suffix, so URLs read the same in every language.
 */
import type { LiteralMessage } from "@ryu/i18n/react";

export type RemixKind = "duplicate" | "remix";

/** URL suffixes; never translated, so they stay ASCII. */
const SLUG_SUFFIX: Readonly<Record<RemixKind, string>> = {
	duplicate: "copy",
	remix: "remix",
};

export interface RemixDefaults {
	/** The suggested site name, at most 100 characters. */
	name: string;
	/** ASCII text to derive the suggested slug from. */
	slugSeed: string;
}

export function remixDefaults(
	tl: LiteralMessage,
	source: { kind: RemixKind; name: string }
): RemixDefaults {
	const name =
		source.kind === "duplicate"
			? tl("{name} copy", { name: source.name })
			: tl("{name} remix", { name: source.name });
	return {
		name: name.slice(0, 100),
		slugSeed: `${source.name}-${SLUG_SUFFIX[source.kind]}`,
	};
}
