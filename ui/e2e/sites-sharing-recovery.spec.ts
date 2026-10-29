import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { z } from "zod";
import type { RuntimeSite, SiteSettings } from "../../sidecar/src/contracts.ts";
import { settingsInput } from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
import { runtimeSiteSchema } from "../../sidecar/src/site-records.ts";
import { installSitesFixtureCodecs } from "./fixture-codec-loader.ts";

interface SettingsWrite {
	expectedRevision: number;
	settings: SiteSettings;
}

// The existing host authenticates these requests to the actual isolated Sites
// sidecar. Only the explicitly denied PUT below is intercepted by Playwright.
async function connectHost(page: Page): Promise<void> {
	await page.addInitScript(() => {
		Reflect.set(window, "ryu", {
			app: {
				request: async (input: {
					path: string;
					method?: string;
					body?: SiteDataValue;
				}) => {
					const response = await fetch(
						`/__sites${input.path}`,
						(() => {
							const value0 = { method: input.method ?? "GET" };
							const value1 =
								input.body === undefined
									? value0
									: Object.assign(value0, {
											headers: { "content-type": "application/json" },
											body: JSON.stringify(input.body),
										});
							return value1;
						})()
					);
					const value = window.__sitesFixtureDecoders.value(
						await response.json()
					);
					if (!response.ok) {
						throw new Error(
							window.__sitesFixtureDecoders.message(value) ??
								"Sites request failed."
						);
					}
					return value;
				},
			},
		});
	});
}

async function createSite(page: Page, name: string): Promise<RuntimeSite> {
	await connectHost(page);
	await page.goto("/");
	await page.getByRole("button", { name: "New site", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Site name").fill(name);
	await dialog.getByLabel("URL name").fill(`sharing-${Date.now()}`);
	await dialog
		.getByLabel("Description")
		.fill("A private sharing recovery guide.");
	const created = page.waitForResponse(
		(response) =>
			response.url().endsWith("/__sites/projects") &&
			response.request().method() === "POST"
	);
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	const response = await created;
	if (response.status() !== 201) {
		throw new Error(`Project creation failed with ${response.status()}.`);
	}
	const site = runtimeSiteSchema.parse(await response.json());
	await page.getByRole("button", { name: "Share", exact: true }).click();
	await page
		.getByRole("dialog", { name: `Share ${name}`, exact: true })
		.waitFor();
	return site;
}

async function readSite(page: Page, id: string): Promise<RuntimeSite> {
	const response = await page.request.get("/__sites/projects?scope=owned");
	if (!response.ok()) {
		throw new Error(`Persisted Sites read failed with ${response.status()}.`);
	}
	const sites = z.array(runtimeSiteSchema).parse(await response.json());
	const site = sites.find((candidate) => candidate.id === id);
	if (!site) {
		throw new Error(`Persisted Site ${id} is missing.`);
	}
	return site;
}

async function choosePublic(page: Page): Promise<void> {
	await page
		.getByRole("dialog")
		.getByRole("combobox", { name: "Who can visit" })
		.click();
	await page
		.getByRole("option", { name: "Anyone with the link", exact: true })
		.click();
}

async function capture(
	page: Page,
	name: string,
	info: TestInfo
): Promise<void> {
	const directory =
		process.env.RYU_SITES_SHARING_PROOF_DIR ??
		path.resolve(
			import.meta.dirname,
			"../../../../docs/proof/test-coverage-sweep-20260924/evidence/sites-sharing"
		);
	await mkdir(directory, { recursive: true });
	const body = await page.screenshot({
		path: path.join(directory, `${name}.png`),
		fullPage: true,
		animations: "disabled",
	});
	await info.attach(name, { body, contentType: "image/png" });
}

test("Share refuses a denied write without claiming public access, then retries the exact revision", async ({
	page,
}, info) => {
	const site = await createSite(page, "Share refusal recovery");
	const endpoint = `**/__sites/projects/${site.id}/settings`;
	const attempts: SettingsWrite[] = [];
	await page.route(endpoint, async (route) => {
		if (route.request().method() !== "PUT") {
			throw new Error("Unexpected sharing fixture method.");
		}
		attempts.push(settingsInput.parse(route.request().postDataJSON()));
		if (attempts.length === 1) {
			await route.fulfill({
				status: 403,
				json: {
					error: {
						code: "policy_denied",
						message: "Public sharing was refused.",
					},
				},
			});
		} else {
			await route.continue();
		}
	});
	const denied = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/projects/${site.id}/settings`) &&
			response.status() === 403
	);
	await choosePublic(page);
	await denied;
	expect(attempts).toEqual([
		{
			expectedRevision: site.revision,
			settings: { ...site.settings, audience: "public" },
		},
	]);
	expect(await readSite(page, site.id)).toMatchObject({
		revision: site.revision,
		settings: site.settings,
	});
	await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
		"Public sharing was refused."
	);
	// The ready UI must reflect confirmed access, even while showing the refusal.
	await expect(
		page.getByRole("dialog").getByRole("combobox", { name: "Who can visit" })
	).toHaveText(/^private\s*▼?$/);
	await capture(page, "sites-share-refused-ready", info);
	const saved = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/projects/${site.id}/settings`) &&
			response.status() === 200
	);
	await choosePublic(page);
	await saved;
	await expect(
		page.getByText("Public sharing was refused.", { exact: true })
	).toHaveCount(0);
	expect(attempts).toEqual([attempts[0], attempts[0]]);
	expect(await readSite(page, site.id)).toMatchObject({
		revision: site.revision + 1,
		settings: { ...site.settings, audience: "public" },
	});
	await page.reload();
	const card = page.locator("section").filter({
		has: page.getByRole("heading", { name: site.name, exact: true }),
	});
	await card.getByRole("button", { name: "Share", exact: true }).click();
	await expect(
		page.getByRole("dialog").getByRole("combobox", { name: "Who can visit" })
	).toHaveText(/^public\s*▼?$/);
	await capture(page, "sites-share-retry-persisted", info);
});

test("Share reloads a conflicted revision before retry and preserves concurrent settings", async ({
	page,
}, info) => {
	const site = await createSite(page, "Share revision recovery");
	const settings = { ...site.settings, aiDailyLimit: 73, uploads: true };
	const endpoint = `/__sites/projects/${site.id}/settings`;
	const changed = await page.request.put(endpoint, {
		data: { expectedRevision: site.revision, settings },
	});
	expect(changed.status()).toBe(200);
	const concurrent = runtimeSiteSchema.parse(await changed.json());
	const failed = page.waitForResponse(
		(response) => response.url().endsWith(endpoint) && response.status() === 409
	);
	await choosePublic(page);
	const refusal = await failed;
	expect(refusal.request().postDataJSON()).toEqual({
		expectedRevision: site.revision,
		settings: { ...site.settings, audience: "public" },
	});
	await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
		"Site changed. Reload before saving."
	);
	expect(await readSite(page, site.id)).toMatchObject({ ...concurrent });
	await page.keyboard.press("Escape");
	const reloaded = page.waitForResponse(
		(response) =>
			response.url().endsWith("/__sites/projects?scope=owned") &&
			response.request().method() === "GET"
	);
	await page
		.getByRole("alert")
		.getByRole("button", { name: "Reload", exact: true })
		.click();
	await reloaded;
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Share", exact: true }).click();
	await expect(
		page.getByRole("dialog").getByRole("combobox", { name: "Who can visit" })
	).toHaveText(/^private\s*▼?$/);
	const saved = page.waitForResponse(
		(response) => response.url().endsWith(endpoint) && response.status() === 200
	);
	await choosePublic(page);
	const success = await saved;
	expect(success.request().postDataJSON()).toEqual({
		expectedRevision: concurrent.revision,
		settings: { ...settings, audience: "public" },
	});
	expect(await readSite(page, site.id)).toMatchObject({
		revision: concurrent.revision + 1,
		settings: { ...settings, audience: "public" },
	});
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(
		page.getByRole("dialog").getByRole("combobox", { name: "Who can visit" })
	).toHaveText(/^public\s*▼?$/);
	await capture(page, "sites-share-revision-retry-persisted", info);
});

test.beforeEach(async ({ page }) => {
	await installSitesFixtureCodecs(page);
});
