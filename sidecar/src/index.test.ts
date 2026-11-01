import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginDataDir } from "@ryu/sidecar-runtime";

const entry = join(import.meta.dir, "index.ts");
const dataRoot = mkdtempSync(join(tmpdir(), "ryu-sites-process-"));
const API_TOKEN = "process-test-token-0123456789abcdefghij";
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));
// Windows has no POSIX permission bits: its file modes only mirror read-only.
const ownerOnly = process.platform !== "win32";

// Ask the OS for two distinct free loopback ports instead of guessing random
// ones that may already be taken on a shared machine. Both listeners stay open
// together so the ports differ, then close before the sidecar binds them.
function freePorts(): { port: number; visitorPort: number } {
	const listeners = [0, 1].map(() =>
		Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
	);
	const [first, second] = listeners;
	if (first === undefined || second === undefined) {
		throw new Error("Expected two free ports");
	}
	const ports = { port: first.port, visitorPort: second.port };
	for (const listener of listeners) {
		listener.stop(true);
	}
	return ports;
}

function start(env: Record<string, string>) {
	return Bun.spawn([process.execPath, entry], {
		env: {
			RYU_PROFILE: "dev",
			RYU_KEYCHAIN: "off",
			RYU_DIR: mkdtempSync(join(dataRoot, "dir-")),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

/** Returns stderr of a process that exited non-zero, or a marker otherwise. */
async function refusal(env: Record<string, string>): Promise<string> {
	const child = start(env);
	const exit = await child.exited;
	const stderr = await new Response(child.stderr).text();
	return exit === 0 ? "<started>" : stderr;
}

async function waitForHealth(port: number) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			if (response.ok) {
				return;
			}
		} catch {
			// Not listening yet.
		}
		await Bun.sleep(50);
	}
	throw new Error("Sites did not become healthy");
}

describe("Sites process startup", () => {
	test("refuses Core tokens in standalone mode", async () => {
		expect(
			await refusal({
				RYU_SITES_MODE: "standalone",
				RYU_SITES_API_TOKEN: API_TOKEN,
				RYU_EXT_TOKEN: "core-minted",
			})
		).toContain("rejects Core tokens");
	});

	test("refuses a public management bind with only a Core token", async () => {
		expect(
			await refusal({
				RYU_EXT_TOKEN: "core-minted",
				RYU_SITES_HOSTNAME: "0.0.0.0",
			})
		).toContain("non-loopback Sites management bind");
	});

	test("refuses a short standalone token", async () => {
		expect(
			await refusal({
				RYU_SITES_MODE: "standalone",
				RYU_SITES_API_TOKEN: "short",
			})
		).toContain("RYU_SITES_API_TOKEN must be at least 32 characters");
	});

	test("refuses an edge readiness URL that is not HTTPS or names no domain", async () => {
		for (const url of [
			"http://{host}/_ryu/edge-ready",
			"https://edge.example",
		]) {
			expect(
				await refusal({
					RYU_SITES_MODE: "standalone",
					RYU_SITES_API_TOKEN: API_TOKEN,
					RYU_SITES_EDGE_READINESS_URL: url,
				})
			).toContain("must be an https:// URL that contains {host}");
		}
	});

	test("redirects the standalone home to an operator-set dashboard", async () => {
		const { port, visitorPort } = freePorts();
		const child = start({
			RYU_SITES_MODE: "standalone",
			RYU_SITES_API_TOKEN: API_TOKEN,
			RYU_SITES_PORT: String(port),
			RYU_SITES_VISITOR_PORT: String(visitorPort),
			RYU_PRODUCT_DASHBOARD_URL: "https://example.com/dashboard",
		});
		try {
			await waitForHealth(port);
			const home = await fetch(`http://127.0.0.1:${port}/`, {
				redirect: "manual",
			});
			expect(home.status).toBe(307);
			expect(home.headers.get("location")).toBe(
				"https://example.com/dashboard"
			);
		} finally {
			child.kill();
			await child.exited;
		}
	});

	test("boots standalone with its own bearer and private local data", async () => {
		const { port, visitorPort } = freePorts();
		const directory = mkdtempSync(join(dataRoot, "boot-"));
		const child = start({
			RYU_SITES_MODE: "standalone",
			RYU_SITES_API_TOKEN: API_TOKEN,
			RYU_SITES_PORT: String(port),
			RYU_SITES_VISITOR_PORT: String(visitorPort),
			RYU_DIR: directory,
		});
		// The sidecar keeps its records in its own plugin data folder (#640 layout).
		const dataDir = resolvePluginDataDir(
			{ RYU_PROFILE: "dev", RYU_DIR: directory },
			"@ryu/sites"
		);
		try {
			await waitForHealth(port);
			// Without RYU_PRODUCT_DASHBOARD_URL the home never sends people to Ryu.
			const home = await fetch(`http://127.0.0.1:${port}/`, {
				redirect: "manual",
			});
			expect(home.status).toBe(200);
			expect(home.headers.get("location")).toBeNull();
			expect(await home.json()).toMatchObject({
				name: "ryu-sites",
				health: "/health",
			});
			const status = await fetch(`http://127.0.0.1:${port}/api/sites/status`, {
				headers: { authorization: `Bearer ${API_TOKEN}` },
			});
			expect(await status.json()).toMatchObject({
				mode: "standalone",
				scannerAvailable: true,
				databaseAvailable: true,
				visitorPort,
			});
			const database = join(dataDir, "sites.sqlite");
			expect(existsSync(database)).toBe(true);
			const quotaKey = join(dataDir, "visitor-quota.key");
			expect(statSync(quotaKey).size).toBe(32);
			if (ownerOnly) {
				expect(statSync(database).mode & 0o077).toBe(0);
				expect(statSync(quotaKey).mode & 0o077).toBe(0);
			}
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
