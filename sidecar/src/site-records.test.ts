import { expect, test } from "bun:test";
import { siteDataRecordSchema, siteDataValueSchema } from "./data-values.ts";
import { readStoredSite, runtimeSiteSchema } from "./site-records.ts";
import { SitesStore } from "./store.ts";

test("complete published Site codecs preserve original versions, settings and additive JSON", () => {
	const store = new SitesStore(":memory:");
	try {
		const site = store.create(
			{ name: "Contract", slug: "contract-site" },
			{ id: "owner", email: "owner@example.test", workspaceIds: [] }
		);
		const published = Object.assign(site, {
			metadata: JSON.parse('{"__proto__":{"safe":true},"tags":["a",null]}'),
		});
		expect(runtimeSiteSchema.parse(published)).toBe(published);
		expect(runtimeSiteSchema.parse(published).settings).toBe(
			published.settings
		);
		expect(runtimeSiteSchema.parse(published).versions).toBe(
			published.versions
		);
		expect(siteDataValueSchema.parse(published.metadata)).toBe(
			published.metadata
		);
		expect(JSON.stringify(published.metadata)).toBe(
			'{"__proto__":{"safe":true},"tags":["a",null]}'
		);
		expect(
			runtimeSiteSchema.safeParse({ ...published, settings: {} }).success
		).toBe(false);
		const { template: nativeTemplate, ...missingTemplate } = published;
		expect(nativeTemplate).toBe("website");
		expect(runtimeSiteSchema.safeParse(missingTemplate).success).toBe(false);
		expect(
			runtimeSiteSchema.safeParse({ ...published, template: undefined }).success
		).toBe(false);
		expect(
			runtimeSiteSchema.safeParse({
				...published,
				domains: [{ host: "site.test" }],
			}).success
		).toBe(false);
		expect(
			runtimeSiteSchema.safeParse({
				...published,
				versions: [{ id: "version" }],
			}).success
		).toBe(false);
	} finally {
		store.close();
	}
});

test("stored Site migration retains legacy settings defaults and unrelated original fields", () => {
	const store = new SitesStore(":memory:");
	try {
		const site = store.create(
			{ name: "Legacy", slug: "legacy-site" },
			{ id: "owner", email: "", workspaceIds: [] }
		);
		const encoded = JSON.stringify({
			...site,
			settings: {},
			extra: { retained: true },
		});
		const read = readStoredSite(encoded);
		expect(read.settings.mode).toBe("local");
		expect(read.settings.audience).toBe("private");
		expect(read.settings.extensions).toEqual({
			mcp: false,
			ui: false,
			tools: [],
			connections: [],
		});
		expect(JSON.parse(JSON.stringify(read)).extra).toEqual({ retained: true });
		expect(read.versions).toEqual(site.versions);
		expect(readStoredSite(JSON.stringify(read))).toEqual(read);
	} finally {
		store.close();
	}
});

test("Sites JSON values retain scalar/array/null/undefined and own prototype keys without accepting functions", () => {
	for (const value of [
		null,
		false,
		0,
		"",
		undefined,
		[1, null, "x"],
		JSON.parse('{"__proto__":null,"nested":{"items":[]}}'),
		JSON.parse("1e400"),
	]) {
		expect(siteDataValueSchema.parse(value)).toBe(value);
	}
	expect(siteDataRecordSchema.safeParse([]).success).toBe(false);
	expect(siteDataRecordSchema.safeParse(null).success).toBe(false);
	expect(
		siteDataValueSchema.safeParse({ invoke: () => "unsafe" }).success
	).toBe(false);
	expect(
		siteDataValueSchema.safeParse(JSON.parse('{"__proto__":0}')).success
	).toBe(true);
});
