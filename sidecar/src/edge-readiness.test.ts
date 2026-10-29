import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEdgeReadiness,
	createPinnedHttpsSend,
	EDGE_READY_PATH,
	type EdgeProbeReply,
	type EdgeProbeSend,
	edgeReadinessUrl,
	isPublicAddress,
} from "./edge-readiness.ts";
import { runtimeConfigSchema } from "./runtime-config.ts";

const PUBLIC_ANSWER = [{ address: "93.184.215.14", family: 4 }];

function recordingSend(
	reply: (url: URL) => EdgeProbeReply | Promise<EdgeProbeReply>
) {
	const sent: { url: string; address: string | null }[] = [];
	const send: EdgeProbeSend = ({ address, url }) => {
		sent.push({ url: url.href, address: address?.address ?? null });
		return Promise.resolve(reply(url));
	};
	return { send, sent };
}
const ready = (host: string) => ({
	status: 200,
	body: JSON.stringify({ ready: true, host }),
});

describe("edge readiness configuration", () => {
	test("accepts only HTTPS URL templates that name the domain", () => {
		for (const url of [
			"https://{host}/_ryu/edge-ready",
			"https://edge.example.com/ready?host={host}",
		]) {
			expect(edgeReadinessUrl.safeParse(url).success).toBe(true);
		}
		for (const url of [
			"http://{host}/_ryu/edge-ready",
			"https://edge.example.com/ready",
			"https://user:secret@edge.example.com/ready?host={host}",
			"not a url {host}",
		]) {
			expect(edgeReadinessUrl.safeParse(url).success).toBe(false);
		}
		expect(() =>
			createEdgeReadiness({ readinessUrl: "http://{host}/ready" })
		).toThrow("must be an https:// URL that contains {host}");
	});

	test("is optional in the runtime configuration and strict when present", () => {
		expect(runtimeConfigSchema.parse({}).edge).toBeUndefined();
		expect(
			runtimeConfigSchema.parse({
				edge: { readinessUrl: `https://{host}${EDGE_READY_PATH}` },
			}).edge
		).toEqual({ readinessUrl: `https://{host}${EDGE_READY_PATH}` });
		expect(
			runtimeConfigSchema.safeParse({
				edge: { readinessUrl: "https://{host}/ready", apiKey: "secret" },
			}).success
		).toBe(false);
	});
});

describe("edge readiness probe", () => {
	test("is ready only for a 200 reply naming the same domain", async () => {
		const { send, sent } = recordingSend((url) =>
			ready(url.searchParams.get("host") ?? "")
		);
		const probe = createEdgeReadiness({
			readinessUrl: "https://edge.example.com/ready?host={host}",
			resolve: () =>
				Promise.reject(new Error("an operator host is not screened")),
			send,
		});
		expect(await probe("site-1", "help.example.com")).toBe(true);
		expect(sent).toEqual([
			{
				url: "https://edge.example.com/ready?host=help.example.com",
				address: null,
			},
		]);
	});

	test("pins a tenant hostname to its screened public address", async () => {
		const resolved: string[] = [];
		const { send, sent } = recordingSend((url) => ready(url.hostname));
		const probe = createEdgeReadiness({
			readinessUrl: `https://{host}${EDGE_READY_PATH}`,
			resolve: (hostname) => {
				resolved.push(hostname);
				return Promise.resolve(PUBLIC_ANSWER);
			},
			send,
		});
		expect(await probe("site-1", "help.example.com")).toBe(true);
		expect(resolved).toEqual(["help.example.com"]);
		expect(sent).toEqual([
			{
				url: `https://help.example.com${EDGE_READY_PATH}`,
				address: "93.184.215.14",
			},
		]);
	});

	test("never connects when the tenant's DNS names a non-public address", async () => {
		const answers = [
			[{ address: "127.0.0.1", family: 4 }],
			[{ address: "10.1.2.3", family: 4 }],
			[{ address: "172.20.0.5", family: 4 }],
			[{ address: "192.168.1.10", family: 4 }],
			[{ address: "169.254.169.254", family: 4 }],
			[{ address: "100.100.100.200", family: 4 }],
			[{ address: "0.0.0.0", family: 4 }],
			[{ address: "::1", family: 6 }],
			[{ address: "fd00:ec2::254", family: 6 }],
			[{ address: "fe80::1", family: 6 }],
			[{ address: "::ffff:127.0.0.1", family: 6 }],
			[{ address: "64:ff9b::a00:1", family: 6 }],
			// One public answer does not excuse a private one.
			[...PUBLIC_ANSWER, { address: "10.0.0.1", family: 4 }],
			[],
		];
		for (const answer of answers) {
			const { send, sent } = recordingSend((url) => ready(url.hostname));
			const probe = createEdgeReadiness({
				readinessUrl: `https://{host}${EDGE_READY_PATH}`,
				resolve: () => Promise.resolve(answer),
				send,
			});
			expect(await probe("site-1", "help.example.com")).toBe(false);
			expect(sent).toEqual([]);
		}
		const { send, sent } = recordingSend((url) => ready(url.hostname));
		const failing = createEdgeReadiness({
			readinessUrl: `https://{host}${EDGE_READY_PATH}`,
			resolve: () => Promise.reject(new Error("NXDOMAIN")),
			send,
		});
		expect(await failing("site-1", "help.example.com")).toBe(false);
		expect(sent).toEqual([]);
	});

	test("classifies public and reserved addresses", () => {
		for (const address of ["93.184.215.14", "1.1.1.1", "2606:4700::1111"]) {
			expect(isPublicAddress(address)).toBe(true);
		}
		for (const address of [
			"192.0.2.1",
			"198.18.0.1",
			"224.0.0.1",
			"255.255.255.255",
			"2001:db8::1",
			"2002:a00:1::",
			"ff02::1",
			"not an address",
		]) {
			expect(isPublicAddress(address)).toBe(false);
		}
	});

	test("stays pending for every other reply", async () => {
		const replies: (() => Promise<EdgeProbeReply>)[] = [
			() => Promise.resolve(ready("other.example.com")),
			() =>
				Promise.resolve({
					status: 200,
					body: JSON.stringify({ ready: false, host: "help.example.com" }),
				}),
			() =>
				Promise.resolve({
					status: 200,
					body: JSON.stringify({ host: "help.example.com" }),
				}),
			() => Promise.resolve({ ...ready("help.example.com"), status: 202 }),
			() => Promise.resolve({ status: 302, body: "" }),
			() =>
				Promise.resolve({
					status: 200,
					body: "<!doctype html><title>edge</title>",
				}),
			() => Promise.resolve({ status: 200, body: null }),
			() => Promise.reject(new TypeError("certificate has expired")),
		];
		for (const reply of replies) {
			const probe = createEdgeReadiness({
				readinessUrl: "https://edge.example.com/ready?host={host}",
				send: reply,
			});
			expect(await probe("site-1", "help.example.com")).toBe(false);
		}
	});

	test("gives up after its timeout, including a slow DNS answer", async () => {
		const hanging: EdgeProbeSend = ({ signal }) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		const slowSend = createEdgeReadiness({
			readinessUrl: "https://edge.example.com/ready?host={host}",
			send: hanging,
			timeoutMs: 20,
		});
		expect(await slowSend("site-1", "help.example.com")).toBe(false);
		const { send, sent } = recordingSend((url) => ready(url.hostname));
		const slowDns = createEdgeReadiness({
			readinessUrl: `https://{host}${EDGE_READY_PATH}`,
			resolve: () => new Promise(() => undefined),
			send,
			timeoutMs: 20,
		});
		expect(await slowDns("site-1", "help.example.com")).toBe(false);
		expect(sent).toEqual([]);
	});
});

describe("pinned HTTPS probe transport", () => {
	// A throwaway certificate authority and a certificate for help.example.com,
	// served from loopback. The probe asks for help.example.com, so reaching this
	// server proves the pinned address replaced DNS, and a successful handshake
	// proves TLS still verified the hostname.
	const directory = mkdtempSync(join(tmpdir(), "ryu-sites-edge-tls-"));
	const openssl = (...args: string[]) => {
		const result = Bun.spawnSync(["openssl", ...args], {
			cwd: directory,
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.toString());
		}
	};
	openssl(
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		"ca.key",
		"-out",
		"ca.pem",
		"-days",
		"2",
		"-subj",
		"/CN=Sites test CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign"
	);
	openssl(
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		"leaf.key",
		"-out",
		"leaf.csr",
		"-subj",
		"/CN=help.example.com"
	);
	writeFileSync(
		join(directory, "leaf.ext"),
		"subjectAltName=DNS:help.example.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n"
	);
	openssl(
		"x509",
		"-req",
		"-in",
		"leaf.csr",
		"-CA",
		"ca.pem",
		"-CAkey",
		"ca.key",
		"-CAcreateserial",
		"-out",
		"leaf.pem",
		"-days",
		"2",
		"-extfile",
		"leaf.ext"
	);
	const ca = readFileSync(join(directory, "ca.pem"), "utf8");
	const seenHosts: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: {
			cert: readFileSync(join(directory, "leaf.pem"), "utf8"),
			key: readFileSync(join(directory, "leaf.key"), "utf8"),
		},
		fetch: (request) => {
			seenHosts.push(request.headers.get("host") ?? "");
			return Response.json({ ready: true, host: "help.example.com" });
		},
	});
	afterAll(() => {
		server.stop(true);
		rmSync(directory, { recursive: true, force: true });
	});
	const pinned = { address: "127.0.0.1", family: 4 as const };
	const probe = (hostname: string, trust?: string) =>
		createPinnedHttpsSend({ ca: trust })({
			address: pinned,
			signal: AbortSignal.timeout(5000),
			url: new URL(`https://${hostname}:${server.port}${EDGE_READY_PATH}`),
		});

	test("connects to the pinned address and verifies the hostname", async () => {
		expect(await probe("help.example.com", ca)).toEqual({
			status: 200,
			body: JSON.stringify({ ready: true, host: "help.example.com" }),
		});
		expect(seenHosts.at(-1)).toBe(`help.example.com:${server.port}`);
	});

	test("refuses a certificate for another name or an untrusted issuer", async () => {
		await expect(probe("other.example.com", ca)).rejects.toThrow();
		await expect(probe("help.example.com")).rejects.toThrow();
	});
});
