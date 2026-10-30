import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import type {} from "./fixture-codecs.ts";

let bundled: string | undefined;
export async function installSitesFixtureCodecs(page: Page): Promise<void> {
	bundled ??= execFileSync(
		"bun",
		[
			"build",
			path.resolve(import.meta.dirname, "fixture-codecs.ts"),
			"--target=browser",
			"--format=iife",
		],
		{ encoding: "utf8" }
	);
	await page.addInitScript({ content: bundled });
}
