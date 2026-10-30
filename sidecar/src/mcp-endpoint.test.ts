import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginDataDir } from "@ryu/sidecar-runtime";
import { randomInstanceValue } from "./instance-proof.ts";
import {
	MANAGEMENT_ENDPOINT_FILE,
	removeManagementEndpoint,
	resolveManagementEndpoint,
	writeManagementEndpoint,
} from "./mcp-server.ts";

const dataRoot = mkdtempSync(join(tmpdir(), "ryu-sites-mcp-endpoint-"));
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));
// Windows has no POSIX permission bits: its file modes only mirror read-only.
const ownerOnly = process.platform !== "win32";

describe("Sites MCP process wiring", () => {
	test("finds the sidecar only through its recorded endpoint", () => {
		const env = {
			RYU_PROFILE: "dev",
			RYU_DIR: mkdtempSync(join(dataRoot, "d-")),
		};
		const directory = resolvePluginDataDir(env, "@ryu/sites");
		mkdirSync(directory, { recursive: true });
		// No profile-default fallback, and an explicit port carries no secret.
		expect(resolveManagementEndpoint(env)).toBeNull();
		expect(
			resolveManagementEndpoint({ ...env, RYU_SITES_PORT: "40001" })
		).toBeNull();
		const secret = randomInstanceValue();
		writeManagementEndpoint(directory, 43_210, secret);
		expect(resolveManagementEndpoint(env)).toEqual({
			baseUrl: "http://127.0.0.1:43210",
			secret,
		});
	});

	test("rewrites a pre-existing endpoint file as owner-only", () => {
		const directory = mkdtempSync(join(dataRoot, "m-"));
		const file = join(directory, MANAGEMENT_ENDPOINT_FILE);
		writeFileSync(file, JSON.stringify({ port: 1 }), { mode: 0o644 });
		const secret = randomInstanceValue();
		writeManagementEndpoint(directory, 43_211, secret);
		if (ownerOnly) {
			expect(statSync(file).mode % 0o1000).toBe(0o600);
		}
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			port: 43_211,
			secret,
		});
	});

	test("removes the endpoint file only for the process that wrote it", () => {
		const directory = mkdtempSync(join(dataRoot, "r-"));
		const file = join(directory, MANAGEMENT_ENDPOINT_FILE);
		const newer = randomInstanceValue();
		writeManagementEndpoint(directory, 43_212, newer);
		removeManagementEndpoint(directory, randomInstanceValue());
		expect(existsSync(file)).toBe(true);
		removeManagementEndpoint(directory, newer);
		expect(existsSync(file)).toBe(false);
	});
});
