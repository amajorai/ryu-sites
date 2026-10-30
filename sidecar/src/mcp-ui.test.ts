import { expect, test } from "bun:test";
import { siteSettings } from "./contracts.ts";
import { siteUiResource } from "./mcp-ui.ts";
import { previewDocument } from "./preview.ts";
import { visitorScript } from "./visitor-bundle.ts";

test("inline Site UI runtime remains valid JavaScript after HTML injection", () => {
	const extensions = siteSettings.parse({}).extensions;
	const site = {
		id: "test-site",
		deploymentId: "version",
		name: "Site",
		settings: siteSettings.parse({}),
		versions: [],
		ownerId: "owner",
		slug: "test-site",
		createdAt: "",
		updatedAt: "",
		revision: 0,
		schemaVersion: 1 as const,
		aliases: [],
		domains: [],
		hasPublished: true,
		prompt: "",
		template: "website" as const,
	};
	const resource = siteUiResource(
		site,
		extensions,
		'<!doctype html><html><head><title>Site</title></head><body><script src="/_ryu/runtime.js"></script><script>document.title="Ready";</script></body></html>',
		visitorScript,
		"http://test-site.localhost"
	);
	const scripts = [
		...resource.text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi),
	];
	expect(scripts).toHaveLength(2);
	for (const script of scripts) {
		expect(() =>
			new Bun.Transpiler({ loader: "js" }).transformSync(script[1])
		).not.toThrow();
	}
});

test("preview injection treats dollar replacement tokens as literal runtime code", () => {
	const runtime = 'globalThis.marker="$&";globalThis.other="$`";';
	expect(
		previewDocument(
			'<!doctype html><script src="/_ryu/runtime.js"></script>',
			runtime
		)
	).toContain(`<script>${runtime}</script>`);
});
