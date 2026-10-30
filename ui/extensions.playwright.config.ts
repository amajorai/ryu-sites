import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "e2e",
	testMatch: "extensions.spec.ts",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	use: {
		headless: true,
		viewport: { width: 1440, height: 1000 },
		launchOptions: {
			args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
		},
	},
	webServer: {
		command: "bun e2e/extensions-harness.ts",
		url: "http://127.0.0.1:8441",
		reuseExistingServer: false,
		timeout: 60_000,
	},
	outputDir: "../../../target/sites-extension-playwright",
	reporter: "list",
});
