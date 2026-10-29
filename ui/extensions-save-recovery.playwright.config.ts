import { defineConfig } from "@playwright/test";
import base from "./extensions.playwright.config.ts";

export default defineConfig({
	...base,
	testDir: `${import.meta.dirname}/e2e`,
	testMatch: "extensions-save-recovery.spec.ts",
	fullyParallel: false,
	workers: 1,
	timeout: 90_000,
	outputDir:
		process.env.RYU_SITES_EXTENSIONS_RESULTS_DIR ??
		"../../../target/sites-extensions-save-recovery",
	use: { ...base.use, trace: "retain-on-failure" },
	webServer: {
		cwd: import.meta.dirname,
		command: "bun run build && bun e2e/extensions-harness.ts",
		url: "http://127.0.0.1:8441",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
