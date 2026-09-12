import { describe, expect, test } from "bun:test";
import {
	canEdit,
	canVisit,
	createSiteInput,
	type RuntimeSite,
	siteSettings,
} from "../../sidecar/src/contracts.ts";
import { previewDocument } from "../../sidecar/src/preview.ts";
import { starterHtml } from "../../sidecar/src/templates.ts";

const site = {
	ownerId: "owner",
	settings: siteSettings.parse({
		workspaceId: "org",
		editors: ["editor@example.com"],
		viewers: ["viewer@example.com"],
		audience: "invited",
	}),
} as RuntimeSite;
describe("site capability defaults", () => {
	test("new sites are private, local and have no server resources", () => {
		const settings = siteSettings.parse({});
		expect(settings.audience).toBe("private");
		expect(settings.mode).toBe("local");
		expect(settings.storage).toBe(false);
		expect(settings.uploads).toBe(false);
		expect(settings.spaceId).toBeNull();
		expect(
			createSiteInput.safeParse({ name: "bad", slug: "bad--slug" }).success
		).toBe(false);
	});
	test("visitor grants cannot edit and editor grants require current workspace membership", () => {
		const viewer = { id: "v", email: "viewer@example.com", workspaceIds: [] };
		expect(canVisit(site, viewer)).toBe(true);
		expect(canEdit(site, viewer)).toBe(false);
		expect(
			canEdit(site, { id: "e", email: "editor@example.com", workspaceIds: [] })
		).toBe(false);
		expect(
			canEdit(site, {
				id: "e",
				email: "editor@example.com",
				workspaceIds: ["org"],
			})
		).toBe(true);
	});
	test("template content is escaped and preview policy precedes arbitrary HTML", () => {
		const html = starterHtml(
			"<script>attack()</script>",
			"help-center",
			'<img src=x onerror="attack()">'
		);
		expect(html).not.toContain("<script>attack()</script>");
		expect(html).toContain("&lt;script&gt;");
		const preview = previewDocument(html, 'window.runtime = "</script>";');
		expect(preview.indexOf("Content-Security-Policy")).toBeLessThan(
			preview.indexOf("<html")
		);
		expect(preview).toContain("connect-src 'none'");
		expect(preview).not.toContain('<script src="/_ryu/runtime.js">');
	});

	test("reset calendar starter stays provider-aware and action-gated", () => {
		const html = starterHtml(
			"Reset Atlas",
			"reset-calendar",
			"Track the windows that matter."
		);
		expect(html).toContain("Codex");
		expect(html).toContain("Claude Code");
		expect(html).toContain("GitHub Copilot");
		expect(html).toContain("Month");
		expect(html).toContain("Agenda");
		expect(html).toContain("Use reset");
		expect(html).toContain("RyuSite.requestReset");
	});
});
