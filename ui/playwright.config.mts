import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const appRoot = import.meta.dirname;
const hostPort = Number(process.env.RYU_SITES_TEST_HOST_PORT ?? "48231");
const managementPort = Number(
	process.env.RYU_SITES_TEST_MANAGEMENT_PORT ?? "48233"
);
const visitorPort = Number(process.env.RYU_SITES_TEST_VISITOR_PORT ?? "48232");
const baseURL = `http://127.0.0.1:${hostPort}`;

export default defineConfig({
	testDir: path.resolve(appRoot, "e2e"),
	testMatch: "sites-runtime.spec.ts",
	timeout: 90_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	outputDir: path.resolve(appRoot, "../../../target/sites-playwright-results"),
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		viewport: { width: 1440, height: 960 },
	},
	webServer: {
		command: "bun run build && node e2e/sites-runtime-server.mjs",
		cwd: appRoot,
		env: {
			...process.env,
			RYU_SITES_TEST_HOST_PORT: String(hostPort),
			RYU_SITES_TEST_MANAGEMENT_PORT: String(managementPort),
			RYU_SITES_TEST_VISITOR_PORT: String(visitorPort),
		},
		url: `${baseURL}/__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
