import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { slugFrom } from "./gallery.tsx";
import { remixDefaults } from "./remix-name.ts";

const DE: Record<string, string> = {
	"{name} copy": "{name} (Kopie)",
	"{name} remix": "{name} (Remix)",
};
const de: LiteralMessage = (source, values) =>
	formatMessage(DE[source] ?? source, values, "de");
const en: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

test("English defaults keep the old name and slug", () => {
	const copy = remixDefaults(en, { kind: "duplicate", name: "My Shop" });
	expect(copy.name).toBe("My Shop copy");
	expect(slugFrom(copy.slugSeed)).toBe("my-shop-copy");
	const remix = remixDefaults(en, { kind: "remix", name: "My Shop" });
	expect(remix.name).toBe("My Shop remix");
	expect(slugFrom(remix.slugSeed)).toBe("my-shop-remix");
});

test("the suggested name is translated while the slug suffix stays ASCII", () => {
	const copy = remixDefaults(de, { kind: "duplicate", name: "Mein Shop" });
	expect(copy.name).toBe("Mein Shop (Kopie)");
	expect(slugFrom(copy.slugSeed)).toBe("mein-shop-copy");
	const remix = remixDefaults(de, { kind: "remix", name: "Mein Shop" });
	expect(remix.name).toBe("Mein Shop (Remix)");
	expect(slugFrom(remix.slugSeed)).toBe("mein-shop-remix");
});

test("the suggested name is capped at 100 characters", () => {
	const long = "x".repeat(120);
	expect(
		remixDefaults(en, { kind: "duplicate", name: long }).name
	).toHaveLength(100);
});
