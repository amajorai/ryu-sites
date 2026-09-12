import { describe, expect, test } from "bun:test";
import {
	domainStatusCopy,
	managedSiteHostname,
	managedSiteOrigin,
	quotaState,
	routeDisplay,
	widgetScriptSnippet,
} from "./site-state.ts";

describe("Sites public-edge display state", () => {
	test("generates a stable wildcard-managed hostname from a project slug", () => {
		expect(managedSiteHostname(" Northstar Docs ")).toBe(
			"northstar-docs.sites.ryu.app"
		);
		expect(managedSiteHostname("---")).toBe("site.sites.ryu.app");
		expect(managedSiteOrigin("northstar-docs")).toBe(
			"https://northstar-docs.sites.ryu.app"
		);
	});

	test("displays a route with a normalized path prefix", () => {
		expect(
			routeDisplay({
				host: "northstar-docs.sites.ryu.app",
				pathPrefix: "widget.js/",
			})
		).toBe("northstar-docs.sites.ryu.app/widget.js");
		expect(
			routeDisplay({
				host: "northstar-docs.sites.ryu.app",
				pathPrefix: "/",
			})
		).toBe("northstar-docs.sites.ryu.app/");
	});

	test("only calls a domain active when DNS and TLS are ready", () => {
		expect(domainStatusCopy("active")).toMatchObject({
			label: "Live",
			tone: "success",
		});
		expect(domainStatusCopy("pending_dns").label).toBe("DNS pending");
		expect(domainStatusCopy("pending_tls").label).toBe("TLS pending");
	});

	test("classifies quota states at healthy, attention, and exhausted thresholds", () => {
		expect(quotaState(4, 10)).toBe("healthy");
		expect(quotaState(8, 10)).toBe("attention");
		expect(quotaState(10, 10)).toBe("exhausted");
		expect(quotaState(1, 0)).toBe("exhausted");
	});

	test("builds a public-only widget snippet", () => {
		const snippet = widgetScriptSnippet(
			{ slug: "Northstar Docs" },
			"site_public_northstar_demo"
		);

		expect(snippet).toContain("https://northstar-docs.sites.ryu.app/widget.js");
		expect(snippet).toContain('data-site-key="site_public_northstar_demo"');
		expect(snippet).not.toMatch(/node|cloudflare|space|secret/i);
	});
});
