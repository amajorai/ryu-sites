/**
 * Shutdown: the listeners and routers are scoped resources, and the sidecar
 * process releases them (and its management endpoint file) on SIGTERM/SIGINT.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginDataDir } from "@ryu/sidecar-runtime";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
	createSitesServer,
	SitesListeners,
	sitesServerLayer,
} from "./server.ts";
import { SitesStore } from "./store.ts";

const dataRoot = mkdtempSync(join(tmpdir(), "ryu-sites-shutdown-"));
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));

const API_TOKEN = "shutdown-test-token-0123456789abcdefghij";

async function reachable(port: number) {
	try {
		await fetch(`http://127.0.0.1:${port}/health`);
		return true;
	} catch {
		return false;
	}
}

describe("Sites listener scope", () => {
	test("closing the layer's scope stops both listeners", async () => {
		const store = new SitesStore(":memory:");
		const scope = Scope.makeUnsafe();
		const { admin, visitor } = Context.get(
			await Effect.runPromise(
				Layer.buildWithScope(
					sitesServerLayer({ store, token: null, port: 0, visitorPort: 0 }),
					scope
				)
			),
			SitesListeners
		);
		const adminPort = admin.port ?? 0;
		const visitorPort = visitor.port ?? 0;
		expect(
			await (await fetch(`http://127.0.0.1:${adminPort}/health`)).json()
		).toEqual({
			ok: true,
		});
		expect(await reachable(visitorPort)).toBe(true);
		await Effect.runPromise(Scope.close(scope, Exit.void));
		expect(await reachable(adminPort)).toBe(false);
		expect(await reachable(visitorPort)).toBe(false);
		store.close();
	});

	test("createSitesServer().close() releases everything once", async () => {
		const store = new SitesStore(":memory:");
		const server = createSitesServer({
			store,
			token: null,
			port: 0,
			visitorPort: 0,
		});
		const port = server.admin.port ?? 0;
		expect(await reachable(port)).toBe(true);
		await Promise.all([server.close(), server.close()]);
		expect(await reachable(port)).toBe(false);
		server.stop();
		store.close();
	});

	test("a port in use throws Bun's own error and releases what started", async () => {
		// Bind the blocker to the listeners' own loopback address. On macOS a
		// wildcard bind does not stop a later, more specific 127.0.0.1 bind of the
		// same port, so a wildcard blocker never produced EADDRINUSE there.
		const blocker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("busy"),
		});
		const store = new SitesStore(":memory:");
		try {
			const { port: free } = freePorts();
			for (const ports of [
				{ port: free, visitorPort: blocker.port ?? 0 },
				{ port: blocker.port ?? 0, visitorPort: 0 },
			]) {
				let thrown: unknown;
				try {
					createSitesServer({ store, token: null, ...ports });
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(Error);
				expect((thrown as { code?: string }).code).toBe("EADDRINUSE");
			}
			// The management listener that did bind is stopped again.
			let open = true;
			for (let attempt = 0; attempt < 40 && open; attempt += 1) {
				open = await reachable(free);
				if (open) {
					await Bun.sleep(25);
				}
			}
			expect(open).toBe(false);
		} finally {
			blocker.stop(true);
			store.close();
		}
	});
});

function freePorts() {
	const listeners = [0, 1].map(() =>
		Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
	);
	const ports = listeners.map((listener) => listener.port);
	for (const listener of listeners) {
		listener.stop(true);
	}
	return { port: ports[0] ?? 0, visitorPort: ports[1] ?? 0 };
}

// Windows has no POSIX signal delivery: `child.kill(signal)` terminates the
// process outright (exit 143/130) without running its handlers, so these
// tests cover the POSIX hosts the handlers exist for.
const posixSignals =
	process.platform === "win32" ? [] : (["SIGTERM", "SIGINT"] as const);

describe("Sites process shutdown", () => {
	for (const signal of posixSignals) {
		test(`${signal} stops the listeners and removes the endpoint file`, async () => {
			const { port, visitorPort } = freePorts();
			const directory = mkdtempSync(join(dataRoot, "run-"));
			const env = {
				RYU_PROFILE: "dev",
				RYU_KEYCHAIN: "off",
				RYU_DIR: directory,
			};
			const child = Bun.spawn(
				[process.execPath, join(import.meta.dir, "index.ts")],
				{
					env: {
						...env,
						RYU_SITES_MODE: "standalone",
						RYU_SITES_API_TOKEN: API_TOKEN,
						RYU_SITES_PORT: String(port),
						RYU_SITES_VISITOR_PORT: String(visitorPort),
					},
					stdout: "pipe",
					stderr: "pipe",
				}
			);
			const endpoint = join(
				resolvePluginDataDir(env, "@ryu/sites"),
				"management-endpoint.json"
			);
			try {
				let healthy = false;
				for (let attempt = 0; attempt < 100 && !healthy; attempt += 1) {
					healthy = await reachable(port);
					if (!healthy) {
						await Bun.sleep(50);
					}
				}
				expect(healthy).toBe(true);
				expect(existsSync(endpoint)).toBe(true);
				child.kill(signal);
				expect(await child.exited).toBe(0);
				expect(existsSync(endpoint)).toBe(false);
				expect(await reachable(port)).toBe(false);
				expect(await reachable(visitorPort)).toBe(false);
			} finally {
				child.kill();
				await child.exited;
			}
		});
	}
});
