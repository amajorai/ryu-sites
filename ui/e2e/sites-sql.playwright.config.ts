import { defineConfig } from "@playwright/test";
import base from "../playwright.config.mts";

const hostPort = 48_241;
const managementPort = 48_243;
const visitorPort = 48_242;
const baseURL = `http://127.0.0.1:${hostPort}`;

export default defineConfig({
	...base,
	testMatch: "sites-sql-recovery.spec.ts",
	workers: 1,
	outputDir: process.env.RYU_SITES_SQL_RESULTS_DIR ?? "test-results/sql",
	use: { ...base.use, baseURL },
	webServer: {
		command: "bun run build && node e2e/sites-runtime-server.mjs",
		cwd: new URL("..", import.meta.url).pathname,
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
