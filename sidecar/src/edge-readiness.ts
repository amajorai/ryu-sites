import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import {
	addressInNetworks,
	parseAddress,
	parseTrustedProxies,
} from "./client-address.ts";

/**
 * Visitor path that answers for every custom domain bound in this service, so
 * an operator can point the readiness URL at the domain itself and prove that
 * the edge serves it over HTTPS and forwards it to this visitor listener.
 */
export const EDGE_READY_PATH = "/_ryu/edge-ready";
/** Wall-clock budget for one readiness probe, including its DNS lookup. */
export const EDGE_READINESS_TIMEOUT_MS = 5000;
const MAX_REPLY_BYTES = 4096;
const HOST_PLACEHOLDER = "{host}";
const HTTPS_PREFIX = "https://";
const INVALID_URL =
	"The Sites edge readiness URL must be an https:// URL that contains {host}";

/**
 * Address ranges a tenant-resolved probe never connects to: unspecified,
 * loopback, private, CGNAT, link-local (including cloud metadata), benchmark,
 * documentation, multicast and reserved IPv4 ranges, and their IPv6
 * counterparts, including unique-local and the prefixes that embed IPv4.
 */
const NON_PUBLIC_NETWORKS = parseTrustedProxies([
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/96",
	"::ffff:0:0/96",
	"64:ff9b::/96",
	"64:ff9b:1::/48",
	"100::/64",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
	"fc00::/7",
	"fe80::/10",
	"fec0::/10",
	"ff00::/8",
]);

/** One address the probe may connect to. */
export interface EdgeProbeAddress {
	address: string;
	family: 4 | 6;
}

/** Resolves every address of a hostname. */
export type EdgeHostResolver = (
	hostname: string
) => Promise<readonly { address: string; family: number }[]>;

/** One probe reply; `body` is null when it exceeded the reply cap. */
export interface EdgeProbeReply {
	body: string | null;
	status: number;
}

/**
 * Sends one probe. With `address`, the connection goes to that screened
 * address while TLS still names and verifies `url.hostname`.
 */
export type EdgeProbeSend = (request: {
	address: EdgeProbeAddress | null;
	signal: AbortSignal;
	url: URL;
}) => Promise<EdgeProbeReply>;

/** An HTTPS URL template; `{host}` is replaced by the custom domain checked. */
export const edgeReadinessUrl = z
	.string()
	.max(2000)
	.refine((value) => {
		if (!value.includes(HOST_PLACEHOLDER)) {
			return false;
		}
		try {
			const url = new URL(value.replaceAll(HOST_PLACEHOLDER, "example.com"));
			return url.protocol === "https:" && !(url.username || url.password);
		} catch {
			return false;
		}
	}, INVALID_URL);

/** Operator-owned `edge` block of the runtime configuration. */
export const edgeConfigSchema = z
	.object({ readinessUrl: edgeReadinessUrl })
	.strict();

const readinessReply = z.object({ ready: z.literal(true), host: z.string() });

/** True for an address outside every loopback, private and reserved range. */
export function isPublicAddress(address: string): boolean {
	return (
		parseAddress(address) !== null &&
		!addressInNetworks(address, NON_PUBLIC_NETWORKS)
	);
}

const systemResolver: EdgeHostResolver = (hostname) =>
	lookup(hostname, { all: true, verbatim: true });

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}

/**
 * Resolves a tenant-controlled hostname and returns one address to pin, or
 * null when it does not resolve or any answer is not public. Refusing on any
 * non-public answer keeps a mixed answer from steering the connection inward.
 */
export async function screenProbeHost(
	hostname: string,
	resolve: EdgeHostResolver,
	signal: AbortSignal
): Promise<EdgeProbeAddress | null> {
	const literal = isIP(hostname);
	const answers = literal
		? [{ address: hostname, family: literal }]
		: await abortable(resolve(hostname), signal).catch(() => []);
	const first = answers[0];
	if (!first || answers.some((answer) => !isPublicAddress(answer.address))) {
		return null;
	}
	return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * The default probe transport: one HTTPS GET with the system trust store,
 * SNI and certificate verification for the URL's hostname, no redirects, an
 * identity encoding and a 4 KB reply cap. A pinned address replaces the DNS
 * lookup at the socket, so the screened address is the one connected to.
 * `ca` exists for tests that run their own certificate authority.
 */
export function createPinnedHttpsSend(
	options: { ca?: string } = {}
): EdgeProbeSend {
	return ({ address, signal, url }) =>
		new Promise((resolve, reject) => {
			const pinnedLookup = address
				? (
						_hostname: string,
						lookupOptions: LookupOptions,
						callback: (
							error: NodeJS.ErrnoException | null,
							result: string | LookupAddress[],
							family?: number
						) => void
					) => {
						if (lookupOptions.all) {
							callback(null, [address]);
						} else {
							callback(null, address.address, address.family);
						}
					}
				: undefined;
			const outgoing = httpsRequest(
				{
					hostname: url.hostname,
					port: Number(url.port || 443),
					path: `${url.pathname}${url.search}`,
					method: "GET",
					headers: {
						accept: "application/json",
						"accept-encoding": "identity",
					},
					servername: url.hostname,
					ca: options.ca,
					lookup: pinnedLookup,
					signal,
				},
				(incoming) => {
					const chunks: Buffer[] = [];
					let size = 0;
					let exceeded = false;
					incoming.on("data", (chunk: Buffer) => {
						if (exceeded) {
							return;
						}
						size += chunk.byteLength;
						if (size > MAX_REPLY_BYTES) {
							exceeded = true;
							incoming.destroy();
							resolve({ status: incoming.statusCode ?? 0, body: null });
							return;
						}
						chunks.push(chunk);
					});
					incoming.on("end", () => {
						if (!exceeded) {
							resolve({
								status: incoming.statusCode ?? 0,
								body: Buffer.concat(chunks).toString("utf8"),
							});
						}
					});
					incoming.on("error", reject);
				}
			);
			outgoing.on("error", reject);
			outgoing.end();
		});
}

/** True when `{host}` is part of the template's hostname, not its path or query. */
function hostFromTenant(template: string): boolean {
	const authority = template.slice(HTTPS_PREFIX.length).split(/[/?#]/)[0] ?? "";
	return authority.includes(HOST_PLACEHOLDER);
}

/**
 * Builds `services.domainReady` from the operator's readiness URL. A domain is
 * ready only when an HTTPS GET of the URL returns `200` with
 * `{"ready": true, "host": "<domain>"}` naming the same domain. Redirects,
 * other statuses, oversized or malformed replies, TLS failures and timeouts
 * all leave the domain pending TLS.
 *
 * When `{host}` is part of the URL's hostname, the tenant's DNS chooses the
 * address, so the hostname is resolved first, the probe is refused when any
 * answer is loopback, private, link-local or otherwise not public, and the
 * connection is pinned to the screened address. A fixed operator hostname is
 * the operator's own choice and is not screened.
 */
export function createEdgeReadiness(options: {
	readinessUrl: string;
	resolve?: EdgeHostResolver;
	send?: EdgeProbeSend;
	timeoutMs?: number;
}): (siteId: string, host: string) => Promise<boolean> {
	const parsed = edgeReadinessUrl.safeParse(options.readinessUrl);
	if (!parsed.success) {
		throw new Error(INVALID_URL);
	}
	const template = parsed.data;
	const screened = hostFromTenant(template);
	const resolve = options.resolve ?? systemResolver;
	const send = options.send ?? createPinnedHttpsSend();
	const timeoutMs = options.timeoutMs ?? EDGE_READINESS_TIMEOUT_MS;
	return async (_siteId, host) => {
		let url: URL;
		try {
			url = new URL(
				template.replaceAll(HOST_PLACEHOLDER, encodeURIComponent(host))
			);
		} catch {
			return false;
		}
		if (url.protocol !== "https:") {
			return false;
		}
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			const address = screened
				? await screenProbeHost(url.hostname, resolve, signal)
				: null;
			if (screened && !address) {
				return false;
			}
			const reply = await abortable(send({ address, signal, url }), signal);
			if (reply.status !== 200 || reply.body === null) {
				return false;
			}
			const answer = readinessReply.safeParse(JSON.parse(reply.body));
			return answer.success && answer.data.host.toLowerCase() === host;
		} catch {
			return false;
		}
	};
}
