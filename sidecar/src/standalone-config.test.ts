import { describe, expect, test } from "bun:test";
import {
	isLoopbackAddress,
	resolveSitesProcessConfig,
	SITES_API_TOKEN_MIN_LENGTH,
} from "./standalone-config.ts";

const strongToken = "a".repeat(SITES_API_TOKEN_MIN_LENGTH);

describe("Core-managed mode stays the default", () => {
	test("uses the Core-minted token, loopback binds and the Core port", () => {
		const config = resolveSitesProcessConfig({
			RYU_EXT_TOKEN: "core-minted",
			RYU_SITES_TOKEN: "override",
			RYU_CORE_PORT: "7000",
		});
		expect(config).toMatchObject({
			mode: "core",
			token: "core-minted",
			hostname: "127.0.0.1",
			visitorHostname: "127.0.0.1",
			corePort: 7000,
			gateway: null,
		});
	});

	test("still refuses to start without any token", () => {
		expect(() => resolveSitesProcessConfig({})).toThrow(
			"Sites requires its Core-minted extension token"
		);
	});

	test("refuses a non-loopback management bind without the standalone bearer", () => {
		for (const hostname of ["0.0.0.0", "::", "10.0.0.4"]) {
			expect(() =>
				resolveSitesProcessConfig({
					RYU_EXT_TOKEN: "core-minted",
					RYU_SITES_HOSTNAME: hostname,
				})
			).toThrow("non-loopback Sites management bind");
		}
	});

	test("rejects standalone-only settings in Core mode", () => {
		expect(() =>
			resolveSitesProcessConfig({
				RYU_SITES_MODE: "core",
				RYU_EXT_TOKEN: "core-minted",
				RYU_SITES_API_TOKEN: strongToken,
			})
		).toThrow("cannot be combined with RYU_SITES_API_TOKEN");
		expect(() =>
			resolveSitesProcessConfig({
				RYU_EXT_TOKEN: "core-minted",
				RYU_SITES_GATEWAY_URL: "https://gateway.example.com",
			})
		).toThrow("applies only to RYU_SITES_MODE=standalone");
	});
});

describe("standalone mode", () => {
	test("uses its own bearer, never a Core port, and no dashboard by default", () => {
		const config = resolveSitesProcessConfig({
			RYU_SITES_MODE: "standalone",
			RYU_SITES_API_TOKEN: ` ${strongToken} `,
			RYU_CORE_PORT: "7000",
		});
		expect(config).toMatchObject({
			mode: "standalone",
			token: strongToken,
			corePort: null,
			dashboardUrl: null,
		});
		expect(config.warnings.join(" ")).toContain("RYU_CORE_PORT is ignored");
		expect(
			resolveSitesProcessConfig({
				RYU_SITES_API_TOKEN: strongToken,
				RYU_PRODUCT_DASHBOARD_URL: "   ",
			}).dashboardUrl
		).toBeNull();
	});

	test("refuses Core tokens as standalone credentials", () => {
		for (const name of ["RYU_EXT_TOKEN", "RYU_SITES_TOKEN"]) {
			expect(() =>
				resolveSitesProcessConfig({
					RYU_SITES_MODE: "standalone",
					RYU_SITES_API_TOKEN: strongToken,
					[name]: "core-minted",
				})
			).toThrow("rejects Core tokens");
			expect(() =>
				resolveSitesProcessConfig({
					RYU_SITES_API_TOKEN: strongToken,
					[name]: "core-minted",
				})
			).toThrow("cannot be combined with Core tokens");
		}
		expect(() =>
			resolveSitesProcessConfig({
				RYU_SITES_MODE: "standalone",
				RYU_EXT_TOKEN: strongToken,
			})
		).toThrow("requires RYU_SITES_API_TOKEN");
	});

	test("infers standalone mode from the standalone bearer alone", () => {
		expect(
			resolveSitesProcessConfig({ RYU_SITES_API_TOKEN: strongToken }).mode
		).toBe("standalone");
	});

	test("enforces a minimum token length and refuses placeholders", () => {
		expect(() =>
			resolveSitesProcessConfig({
				RYU_SITES_MODE: "standalone",
				RYU_SITES_API_TOKEN: "a".repeat(SITES_API_TOKEN_MIN_LENGTH - 1),
			})
		).toThrow(`at least ${SITES_API_TOKEN_MIN_LENGTH} characters`);
		expect(() =>
			resolveSitesProcessConfig({
				RYU_SITES_MODE: "standalone",
				RYU_SITES_API_TOKEN: "change-me",
			})
		).toThrow("not a placeholder");
	});

	test("allows public binds and a dashboard override", () => {
		const config = resolveSitesProcessConfig({
			RYU_SITES_MODE: "standalone",
			RYU_SITES_API_TOKEN: strongToken,
			RYU_SITES_HOSTNAME: "0.0.0.0",
			RYU_SITES_VISITOR_HOSTNAME: "::",
			RYU_PRODUCT_DASHBOARD_URL: "https://example.com/org",
		});
		expect(config).toMatchObject({
			hostname: "0.0.0.0",
			visitorHostname: "::",
			dashboardUrl: "https://example.com/org",
		});
	});

	test("requires IP bind addresses", () => {
		expect(() =>
			resolveSitesProcessConfig({
				RYU_SITES_API_TOKEN: strongToken,
				RYU_SITES_VISITOR_HOSTNAME: "sites.example.com",
			})
		).toThrow("RYU_SITES_VISITOR_HOSTNAME must be an IP address");
	});

	test("accepts only HTTPS or loopback HTTP Gateways", () => {
		const base = { RYU_SITES_API_TOKEN: strongToken };
		expect(
			resolveSitesProcessConfig({
				...base,
				RYU_SITES_GATEWAY_URL: "https://gateway.example.com/",
				RYU_SITES_GATEWAY_KEY: "gateway-key",
			}).gateway
		).toEqual({ url: "https://gateway.example.com", key: "gateway-key" });
		expect(
			resolveSitesProcessConfig({
				...base,
				RYU_SITES_GATEWAY_URL: "http://127.0.0.1:7980",
			}).gateway
		).toEqual({ url: "http://127.0.0.1:7980", key: null });
		for (const url of [
			"http://gateway.example.com",
			"https://user:pass@gateway.example.com",
			"https://gateway.example.com/?key=1",
			"not a url",
		]) {
			expect(() =>
				resolveSitesProcessConfig({ ...base, RYU_SITES_GATEWAY_URL: url })
			).toThrow("RYU_SITES_GATEWAY_URL");
		}
		expect(() =>
			resolveSitesProcessConfig({ ...base, RYU_SITES_GATEWAY_KEY: "key" })
		).toThrow("requires RYU_SITES_GATEWAY_URL");
	});

	test("rejects an unknown mode", () => {
		expect(() =>
			resolveSitesProcessConfig({ RYU_SITES_MODE: "hosted" })
		).toThrow("RYU_SITES_MODE must be 'core' or 'standalone'");
	});
});

test("recognizes loopback addresses only", () => {
	expect(isLoopbackAddress("127.0.0.1")).toBe(true);
	expect(isLoopbackAddress("127.8.9.10")).toBe(true);
	expect(isLoopbackAddress("::1")).toBe(true);
	expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
	expect(isLoopbackAddress("0.0.0.0")).toBe(false);
	expect(isLoopbackAddress("::")).toBe(false);
	expect(isLoopbackAddress("192.168.1.2")).toBe(false);
	expect(isLoopbackAddress("localhost")).toBe(false);
});
