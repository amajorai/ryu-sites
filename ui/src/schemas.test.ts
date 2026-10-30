import { expect, test } from "bun:test";
import { sitePlugin } from "../../sidecar/src/extension-routes.ts";
import { SitesStore } from "../../sidecar/src/store.ts";
import {
	extensionStatusSchema,
	queryResultSchema,
	serviceStatusSchema,
} from "./schemas.ts";

test("Sites extensions reply retains the native manifest, nested tool configuration and additive metadata", () => {
	const store = new SitesStore(":memory:");
	try {
		const site = store.create(
			{ name: "Codec", slug: "codec-site" },
			{ id: "owner", email: "", workspaceIds: [] }
		);
		const reply = {
			connections: [],
			plugin: sitePlugin(site, "https://codec-site.example.test"),
			published: site.settings.extensions,
			metadata: JSON.parse('{"__proto__":{"safe":true}}'),
		};
		expect(extensionStatusSchema.parse(reply)).toBe(reply);
		expect(extensionStatusSchema.parse(reply).plugin).toBe(reply.plugin);
		expect(extensionStatusSchema.parse(reply).published).toBe(
			site.settings.extensions
		);
		expect(JSON.stringify(reply.metadata)).toBe('{"__proto__":{"safe":true}}');
		expect(
			extensionStatusSchema.safeParse({
				...reply,
				plugin: { mcp_servers: { site: { url: "https://fixture" } } },
			}).success
		).toBe(false);
	} finally {
		store.close();
	}
});

test("Sites SQL replies preserve native JSON cells and reject malformed schema or rows", () => {
	const cell = JSON.parse('{"__proto__":0,"values":[null,false,1,"x"]}');
	const reply = {
		columns: ["value"],
		rows: [[cell]],
		schema: [{ id: "value", label: "Value", name: "value" }],
		truncated: false,
	};
	expect(queryResultSchema.parse(reply)).toBe(reply);
	expect(queryResultSchema.parse(reply).rows[0]?.[0]).toBe(cell);
	expect(
		queryResultSchema.safeParse({ ...reply, rows: [[() => "invalid"]] }).success
	).toBe(false);
	expect(
		queryResultSchema.safeParse({ ...reply, schema: [{ id: "value" }] }).success
	).toBe(false);
	expect(
		serviceStatusSchema.safeParse({ identityAvailable: true }).success
	).toBe(false);
});
