/**
 * The language a published Site's "Powered by Ryu" badge renders in.
 *
 * The same resolver as the Forms and Bot Flows respondent pages (each
 * satellite keeps its own copy). Visitors are not Ryu users, so the badge
 * follows the browser's `Accept-Language`, then the owner's node locale
 * (`LC_ALL`, `LC_MESSAGES`, `LANG`), then English. Translations come from
 * `respondent-catalog.generated.json`: the official catalog entries for the
 * `tl()` badge copy in `respondent.ts`, written by
 * `scripts/sync-respondent-catalogs.mjs` (the sidecar is a standalone
 * satellite, so it carries its own slice instead of importing `@ryu/i18n`).
 * A sentence a catalog lacks stays English.
 */
import catalogs from "./respondent-catalog.generated.json" with {
	type: "json",
};

export interface RespondentLocale {
	/** Text direction for `<html dir>`. */
	readonly dir: "ltr" | "rtl";
	/** BCP 47 tag for `<html lang>` (`en` when no catalog matches). */
	readonly locale: string;
	/** Translate an English source sentence (placeholders are left intact). */
	tl(source: string): string;
}

const CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>> =
	catalogs;
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);
const MAX_LANGUAGE_RANGES = 20;

/** The official catalog whose language and script match `tag`, `en`, or null. */
function catalogLocaleFor(tag: string): string | null {
	if (Object.hasOwn(CATALOGS, tag)) {
		return tag;
	}
	try {
		const wanted = new Intl.Locale(tag).maximize();
		if (wanted.language === "en") {
			return "en";
		}
		for (const candidate of Object.keys(CATALOGS)) {
			const official = new Intl.Locale(candidate).maximize();
			if (
				official.language === wanted.language &&
				official.script === wanted.script
			) {
				return candidate;
			}
		}
	} catch {
		// An invalid tag matches no catalog.
	}
	return null;
}

/** `Accept-Language` ranges, most preferred first (`*` and `q=0` dropped). */
export function acceptedLanguages(header: string | null | undefined): string[] {
	const ranges: { order: number; q: number; tag: string }[] = [];
	for (const [order, part] of (header ?? "")
		.split(",")
		.slice(0, MAX_LANGUAGE_RANGES)
		.entries()) {
		const [rawTag = "", ...params] = part.split(";");
		const tag = rawTag.trim();
		const qParam = params.find((param) => param.trim().startsWith("q="));
		const q = qParam ? Number(qParam.trim().slice(2)) : 1;
		if (tag && tag !== "*" && Number.isFinite(q) && q > 0) {
			ranges.push({ order, q, tag });
		}
	}
	ranges.sort((left, right) => right.q - left.q || left.order - right.order);
	return ranges.map((range) => range.tag);
}

/** A POSIX locale (`de_DE.UTF-8`) as a BCP 47 tag, or null for `C`/`POSIX`. */
function posixTag(value: string | undefined): string | null {
	const tag = value?.split(/[.@]/u)[0]?.replaceAll("_", "-").trim();
	return tag && tag !== "C" && tag !== "POSIX" ? tag : null;
}

/** The node owner's locale from the process environment, or null. */
export function ownerLocaleFromEnv(
	env: Record<string, string | undefined> = process.env
): string | null {
	return (
		posixTag(env.LC_ALL) ?? posixTag(env.LC_MESSAGES) ?? posixTag(env.LANG)
	);
}

/** A translator for `locale`, which must be `en` or a catalog key. */
export function respondentLocale(locale: string): RespondentLocale {
	const catalog = CATALOGS[locale];
	if (!catalog) {
		return { dir: "ltr", locale: "en", tl: (source) => source };
	}
	const language = new Intl.Locale(locale).language;
	return {
		dir: RTL_LANGUAGES.has(language) ? "rtl" : "ltr",
		locale,
		tl: (source) => catalog[source] ?? source,
	};
}

/**
 * Pick the page language: the first `Accept-Language` range with a catalog
 * (an English range wins outright), else the owner's locale, else English.
 */
export function negotiateRespondentLocale(
	acceptLanguage: string | null | undefined,
	ownerLocale: string | null = ownerLocaleFromEnv()
): RespondentLocale {
	for (const tag of acceptedLanguages(acceptLanguage)) {
		const match = catalogLocaleFor(tag);
		if (match) {
			return respondentLocale(match);
		}
	}
	const owner = ownerLocale ? catalogLocaleFor(ownerLocale) : null;
	return respondentLocale(owner ?? "en");
}

/** Fill `{name}` placeholders of an already translated sentence. */
export function fillPlaceholders(
	message: string,
	values: Readonly<Record<string, string | number>>
): string {
	return message.replace(/\{(\w+)\}/gu, (match, name: string) =>
		Object.hasOwn(values, name) ? String(values[name]) : match
	);
}
