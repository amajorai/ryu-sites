import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../playwright.config.mts";

export default defineConfig({
	...base,
	testMatch: "sites-sharing-recovery.spec.ts",
	fullyParallel: false,
	workers: 1,
	outputDir:
		process.env.RYU_SITES_SHARING_RESULTS_DIR ??
		path.resolve(
			import.meta.dirname,
			"../../../../target/sites-sharing-playwright-results"
		),
	use: { ...base.use, trace: "retain-on-failure" },
	// The main config starts a fresh isolated SQLite sidecar and forbids reuse.
	webServer: base.webServer,
});
