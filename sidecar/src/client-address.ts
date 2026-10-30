import { isIP } from "node:net";

/** One operator-trusted proxy network, stored as an address prefix. */
export interface TrustedNetwork {
	bits: 32 | 128;
	prefix: number;
	value: bigint;
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED_WITH_PORT = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_TAIL = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/;

function ipv4Value(address: string): bigint {
	let value = 0n;
	for (const part of address.split(".")) {
		value = (value << 8n) | BigInt(Number(part));
	}
	return value;
}

function ipv6Value(address: string): bigint | null {
	let text = address;
	const tail = IPV4_TAIL.exec(text);
	if (tail) {
		const embedded = ipv4Value(tail[2] ?? "");
		text = `${tail[1]}${(embedded >> 16n).toString(16)}:${(embedded & 0xff_ffn).toString(16)}`;
	}
	const [head = "", rest] = text.split("::");
	const headGroups = head ? head.split(":") : [];
	const restGroups = rest ? rest.split(":") : [];
	const missing = 8 - headGroups.length - restGroups.length;
	if (rest === undefined ? missing !== 0 : missing < 0) {
		return null;
	}
	let value = 0n;
	for (const group of [
		...headGroups,
		...Array.from({ length: missing }, () => "0"),
		...restGroups,
	]) {
		value = (value << 16n) | BigInt(Number.parseInt(group || "0", 16));
	}
	return value;
}

/** Parses one IP address (IPv4-mapped IPv6 is treated as IPv4). */
export function parseAddress(
	raw: string
): { bits: 32 | 128; value: bigint } | null {
	let text = raw.trim();
	const bracketed = BRACKETED_WITH_PORT.exec(text);
	if (bracketed) {
		text = bracketed[1] ?? "";
	}
	text = IPV4_WITH_PORT.exec(text)?.[1] ?? text;
	text = text.replace(/%.*$/, "");
	text = IPV4_MAPPED.exec(text)?.[1] ?? text;
	const version = isIP(text);
	if (version === 4) {
		return { bits: 32, value: ipv4Value(text) };
	}
	if (version === 6) {
		const value = ipv6Value(text.toLowerCase());
		return value === null ? null : { bits: 128, value };
	}
	return null;
}

/** Parses operator entries such as `127.0.0.1`, `10.0.0.0/8` or `fd00::/8`. */
export function parseTrustedProxies(
	entries: readonly string[]
): TrustedNetwork[] {
	return entries
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [address = "", prefixText] = entry.split("/");
			const parsed = parseAddress(address);
			const prefix =
				prefixText === undefined ? parsed?.bits : Number(prefixText);
			if (
				!parsed ||
				prefix === undefined ||
				!Number.isInteger(prefix) ||
				prefix < 0 ||
				prefix > parsed.bits
			) {
				throw new Error(`Invalid Sites trusted proxy entry: ${entry}`);
			}
			return { ...parsed, prefix };
		});
}

/** True when `address` falls inside one of `networks`. */
export function addressInNetworks(
	address: string,
	networks: readonly TrustedNetwork[]
): boolean {
	return isTrusted(address, networks);
}

function isTrusted(address: string, networks: readonly TrustedNetwork[]) {
	const parsed = parseAddress(address);
	return Boolean(
		parsed &&
			networks.some((network) => {
				if (network.bits !== parsed.bits) {
					return false;
				}
				const shift = BigInt(network.bits - network.prefix);
				return parsed.value >> shift === network.value >> shift;
			})
	);
}

/**
 * Returns the visitor's address. `X-Forwarded-For` is honored only when the
 * connecting peer is an operator-trusted proxy, and it is read right to left
 * so a client can never choose the address by prepending its own entries.
 */
export function visitorClientAddress(
	peer: string,
	headers: Headers,
	networks: readonly TrustedNetwork[]
): string {
	if (!(networks.length && isTrusted(peer, networks))) {
		return peer;
	}
	let nearest = peer;
	const hops = (headers.get("x-forwarded-for") ?? "").split(",").reverse();
	for (const hop of hops) {
		const candidate = hop.trim();
		if (!parseAddress(candidate)) {
			return nearest;
		}
		if (!isTrusted(candidate, networks)) {
			return candidate;
		}
		nearest = candidate;
	}
	return nearest;
}
