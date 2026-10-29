import { expect, test } from "bun:test";
import { parseTrustedProxies, visitorClientAddress } from "./client-address.ts";

const forwarded = (value: string) => new Headers({ "x-forwarded-for": value });

test("trusted proxy entries accept IPv4, IPv6 and CIDR forms and reject the rest", () => {
	const networks = parseTrustedProxies([
		"127.0.0.1",
		" 10.0.0.0/8 ",
		"fd00::/8",
		"::1",
	]);
	expect(networks).toHaveLength(4);
	for (const invalid of ["10.0.0.0/33", "localhost", "fd00::/129", "1.2.3"]) {
		expect(() => parseTrustedProxies([invalid])).toThrow(invalid);
	}
});

test("the visitor address is the nearest untrusted forwarded hop", () => {
	const networks = parseTrustedProxies(["127.0.0.1", "10.0.0.0/8", "fd00::/8"]);
	expect(
		visitorClientAddress("127.0.0.1", forwarded("203.0.113.9"), networks)
	).toBe("203.0.113.9");
	expect(
		visitorClientAddress(
			"::ffff:127.0.0.1",
			forwarded("192.0.2.1, 203.0.113.9, 10.1.2.3"),
			networks
		)
	).toBe("203.0.113.9");
	expect(
		visitorClientAddress(
			"127.0.0.1",
			forwarded("2001:db8::7, fd12:3456::1"),
			networks
		)
	).toBe("2001:db8::7");
	expect(
		visitorClientAddress(
			"127.0.0.1",
			forwarded("not-an-ip, 10.1.2.3"),
			networks
		)
	).toBe("10.1.2.3");
	expect(visitorClientAddress("127.0.0.1", new Headers(), networks)).toBe(
		"127.0.0.1"
	);
	expect(
		visitorClientAddress("192.0.2.200", forwarded("203.0.113.9"), networks)
	).toBe("192.0.2.200");
	expect(visitorClientAddress("127.0.0.1", forwarded("203.0.113.9"), [])).toBe(
		"127.0.0.1"
	);
});
