import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(uiRoot, "dist", "index.html");
const runtimeDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-sites-playwright-")
);
const managementPort = Number(
	process.env.RYU_SITES_TEST_MANAGEMENT_PORT ?? "8423"
);
const visitorPort = Number(process.env.RYU_SITES_TEST_VISITOR_PORT ?? "8422");
const hostPort = Number(process.env.RYU_SITES_TEST_HOST_PORT ?? "8421");
const token = "sites-playwright-local-token";
const requests = [];
// Proxied calls are traced before the sidecar replies. A trace read waits for
// these so it never returns a call that has no status yet.
const pendingCalls = new Set();
let sidecar;
let host;
let shutdownPromise;

function sendJson(response, value, status = 200) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(value));
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

async function waitForSidecar() {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (sidecar.exitCode !== null) {
			throw new Error(
				"Sites sidecar exited before its health endpoint was ready."
			);
		}
		const healthy = await fetch(`http://127.0.0.1:${managementPort}/health`)
			.then((response) => response.ok)
			.catch(() => false);
		if (healthy) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Sites sidecar did not become healthy within 12 seconds.");
}

async function handleRequest(request, response) {
	const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);
	if (url.pathname === "/__ready") {
		sendJson(response, { ok: true });
		return;
	}
	if (url.pathname === "/__proof/requests") {
		while (pendingCalls.size > 0) {
			await Promise.allSettled([...pendingCalls]);
		}
		sendJson(response, requests);
		return;
	}
	if (url.pathname === "/" || url.pathname === "/index.html") {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(await readFile(artifactPath));
		return;
	}
	if (url.pathname === "/__sites" || url.pathname.startsWith("/__sites/")) {
		const method = request.method ?? "GET";
		const apiPath = url.pathname.slice("/__sites".length) || "/";
		const body = await readBody(request);
		let parsedBody;
		if (body.length > 0) {
			try {
				parsedBody = JSON.parse(body.toString("utf8"));
			} catch {
				sendJson(
					response,
					{ error: { message: "Sites expects a JSON body." } },
					400
				);
				return;
			}
		}
		const call = (() => {
			const value0 = { method, path: `${apiPath}${url.search}` };
			const value1 =
				parsedBody === undefined
					? value0
					: Object.assign(value0, { body: parsedBody });
			return value1;
		})();
		requests.push(call);
		const reply = (async () => {
			const upstream = await fetch(
				`http://127.0.0.1:${managementPort}/api/sites${apiPath}${url.search}`,
				(() => {
					const value0 = {
						method,
						headers: (() => {
							const value0 = { authorization: `Bearer ${token}` };
							const value1 =
								body.length > 0
									? Object.assign(value0, {
											"content-type": "application/json",
										})
									: value0;
							return value1;
						})(),
					};
					const value1 =
						body.length > 0 && method !== "GET" && method !== "HEAD"
							? Object.assign(value0, { body })
							: value0;
					return value1;
				})()
			);
			const responseBody = Buffer.from(await upstream.arrayBuffer());
			call.status = upstream.status;
			try {
				call.response = JSON.parse(responseBody.toString("utf8"));
			} catch {
				call.response = responseBody.toString("utf8");
			}
			return { responseBody, upstream };
		})();
		pendingCalls.add(reply);
		const { responseBody, upstream } = await reply.finally(() =>
			pendingCalls.delete(reply)
		);
		response.writeHead(upstream.status, {
			"content-type":
				upstream.headers.get("content-type") ??
				"application/json; charset=utf-8",
		});
		response.end(responseBody);
		return;
	}
	sendJson(
		response,
		{ error: { message: `No Sites fixture route for ${url.pathname}.` } },
		404
	);
}

async function stop() {
	if (shutdownPromise) {
		return shutdownPromise;
	}
	shutdownPromise = (async () => {
		if (host?.listening) {
			await new Promise((resolve) => host.close(resolve));
		}
		if (sidecar && sidecar.exitCode === null && sidecar.signalCode === null) {
			sidecar.kill("SIGTERM");
			await Promise.race([
				new Promise((resolve) => sidecar.once("exit", resolve)),
				new Promise((resolve) => setTimeout(resolve, 5000)),
			]);
			if (sidecar.exitCode === null && sidecar.signalCode === null) {
				sidecar.kill("SIGKILL");
			}
		}
		await rm(runtimeDirectory, { force: true, recursive: true });
	})();
	return shutdownPromise;
}

sidecar = spawn("bun", ["run", "e2e/sites-runtime-sidecar.ts"], {
	cwd: uiRoot,
	env: {
		...process.env,
		RYU_SITES_TEST_DATA_DIR: runtimeDirectory,
		RYU_SITES_TEST_TOKEN: token,
		RYU_SITES_PORT: String(managementPort),
		RYU_SITES_VISITOR_PORT: String(visitorPort),
	},
	stdio: "inherit",
});

try {
	await waitForSidecar();
	if (process.env.RYU_SITES_TEST_METADATA_PATH) {
		await writeFile(
			process.env.RYU_SITES_TEST_METADATA_PATH,
			JSON.stringify({
				runtimeDirectory,
				hostPort,
				managementPort,
				visitorPort,
				pid: process.pid,
			}),
			{ flag: "wx" }
		);
	}
	host = createServer((request, response) => {
		void handleRequest(request, response).catch((error) => {
			sendJson(
				response,
				{
					error: {
						message:
							error instanceof Error ? error.message : "Sites fixture failed.",
					},
				},
				500
			);
		});
	});
	host.listen(hostPort, "127.0.0.1", () => {
		process.stdout.write(`Sites UI fixture listening on ${hostPort}.\n`);
	});
	process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
	process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
} catch (error) {
	await stop();
	throw error;
}
