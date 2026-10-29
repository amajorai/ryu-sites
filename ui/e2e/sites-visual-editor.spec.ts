interface DesignFixtureState {
	errors: string[];
	expectedRefusal: string | null;
	httpErrors: string[];
	unknown: string[];
}

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
import { runtimeSiteSchema } from "../../sidecar/src/site-records.ts";
import { installSitesFixtureCodecs } from "./fixture-codec-loader.ts";

const proofDirectory =
	process.env.RYU_SITES_DESIGN_PROOF_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../../docs/proof/test-coverage-sweep-20260924/evidence/sites-design"
	);
const failures = new WeakMap<
	Page,
	{
		errors: string[];
		unknown: string[];
		httpErrors: string[];
		expectedRefusal: string | null;
	}
>();

async function screenshot(page: Page, name: string): Promise<void> {
	await mkdir(proofDirectory, { recursive: true });
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({
		path: path.join(proofDirectory, name),
		fullPage: true,
		animations: "disabled",
	});
}

test.beforeEach(async ({ page, baseURL }) => {
	await installSitesFixtureCodecs(page);
	if (!baseURL) {
		throw new Error("Design proof requires its real-sidecar config baseURL.");
	}
	const origin = new URL(baseURL).origin;
	const state: DesignFixtureState = {
		errors: [],
		unknown: [],
		httpErrors: [],
		expectedRefusal: null,
	};
	failures.set(page, state);
	page.on("pageerror", (error) => state.errors.push(error.message));
	page.on("response", (response) => {
		const url = new URL(response.url());
		if (url.origin !== origin || response.status() < 400) {
			return;
		}
		if (
			response.status() === 503 &&
			response.request().method() === "POST" &&
			url.pathname === state.expectedRefusal
		) {
			return;
		}
		state.httpErrors.push(
			`${response.status()} ${response.request().method()} ${url.pathname}`
		);
	});
	await page.route(
		(url) => url.pathname.startsWith("/__sites"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const method = request.method();
			const pathname = url.pathname.slice("/__sites".length);
			const valid =
				url.origin === origin &&
				((method === "GET" &&
					pathname === "/projects" &&
					["?scope=owned", "?scope=shared"].includes(url.search)) ||
					(method === "GET" &&
						["/status", "/runtime"].includes(pathname) &&
						!url.search) ||
					(method === "POST" && pathname === "/projects" && !url.search) ||
					(method === "POST" &&
						/^\/projects\/[^/]+\/versions$/.test(pathname) &&
						!url.search) ||
					(method === "GET" &&
						/^\/projects\/[^/]+\/versions\/[^/]+$/.test(pathname) &&
						!url.search));
			if (!valid) {
				state.unknown.push(`${method} ${url.pathname}${url.search}`);
				await route.fulfill({
					status: 500,
					json: { error: { message: "Unexpected Design fixture request" } },
				});
				return;
			}
			await route.continue();
		}
	);
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
								`Sites request failed: ${response.status}`
						);
					}
					return value;
				},
			},
		});
	});
});
test.afterEach(({ page }) => {
	expect(failures.get(page)?.errors).toEqual([]);
	expect(failures.get(page)?.unknown).toEqual([]);
	expect(failures.get(page)?.httpErrors).toEqual([]);
});

// Runs against the isolated real SQLite sidecar through the existing test-only
// loopback bridge). The chat model is a deterministic stub: this proves the
// editor applies validated operations, not a live model round trip.
test("Sites design canvas edits by inspector, drag and drop, and chat", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	await page.getByRole("button", { name: "New site", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Site name", { exact: true }).fill("Canvas Cafe");
	await dialog
		.getByLabel("URL name", { exact: true })
		.fill(`canvas-${Date.now()}`);
	await dialog
		.getByLabel("Description", { exact: true })
		.fill("Coffee and quiet tables.");
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(
		page.getByText("Describe your website", { exact: true })
	).toBeVisible();

	await page.evaluate(() => {
		const bridge = window;
		if (!bridge.ryu) {
			throw new Error("Sites bridge is unavailable");
		}
		bridge.ryu.model = {
			complete: async () =>
				JSON.stringify({
					operations: [
						{
							kind: "insertHtml",
							parentId: "root",
							index: 0,
							html: '<p role="note" style="margin:0;padding:8px;background:#fef3c7">Open late on Fridays</p>',
						},
					],
					summary: "Added an announcement bar.",
				}),
		};
	});
	await page.getByRole("button", { name: "Design", exact: true }).click();
	const canvas = page.frameLocator('iframe[title="Design canvas"]');
	const heading = canvas.getByRole("heading", { name: "Canvas Cafe" });
	await expect(heading).toBeVisible();

	// Select on the canvas, edit through the inspector.
	await heading.click();
	await expect(page.getByLabel("Inspector").getByText("<h1>")).toBeVisible();
	await screenshot(page, "sites-visual-editor-selected.png");
	const text = page.getByLabel("Text", { exact: true });
	await text.fill("Canvas Cafe & Books");
	await text.blur();
	await expect(
		canvas.getByRole("heading", { name: "Canvas Cafe & Books" })
	).toBeVisible();

	// Drag a palette block onto the canvas.
	await page
		.getByRole("button", { name: "Quote", exact: true })
		.dragTo(page.locator('iframe[title="Design canvas"]'), {
			targetPosition: { x: 400, y: 40 },
		});
	await expect(canvas.getByText("“A quote that builds trust.”")).toBeVisible();

	// Chat applies typed operations; undo reverts them.
	await page
		.getByLabel("Describe a change")
		.fill("Add an announcement that we are open late on Fridays");
	await page.getByRole("button", { name: "Apply", exact: true }).click();
	await expect(
		page.getByText("Added an announcement bar. Undo is available.")
	).toBeVisible();
	await expect(canvas.getByText("Open late on Fridays")).toBeVisible();
	await screenshot(page, "sites-visual-editor.png");
	await page.getByRole("button", { name: "Undo", exact: true }).click();
	await expect(canvas.getByText("Open late on Fridays")).toHaveCount(0);
	await page.getByRole("button", { name: "Redo", exact: true }).click();
	await expect(canvas.getByText("Open late on Fridays")).toBeVisible();

	// The saved build carries the edits and no editor ids; scripts still run in Preview.
	await page.getByRole("button", { name: "Source", exact: true }).click();
	const source = await page.getByLabel("HTML source").inputValue();
	expect(source).toContain("Canvas Cafe &amp; Books");
	expect(source).toContain("Open late on Fridays");
	expect(source).not.toContain("data-ryu-node");
	expect(source).not.toContain("data-ryu-selected");
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await expect(
		page.getByText("Version saved. The deployed version has not changed.")
	).toBeVisible();

	await page.getByRole("button", { name: "Design", exact: true }).click();
	await expect(canvas.getByText("Open late on Fridays")).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await screenshot(page, "sites-visual-editor-mobile.png");
	await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
	expect(errors).toEqual([]);
});

test("Design save refusal retains the edited artifact; explicit retry persists one immutable version without deployment", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "New site", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Site name", { exact: true })
		.fill("Design retry cafe");
	await dialog
		.getByLabel("URL name", { exact: true })
		.fill(`design-retry-${Date.now()}`);
	await dialog
		.getByLabel("Description", { exact: true })
		.fill("Keep this draft after a refused save.");
	const creation = page.waitForResponse(
		(response) =>
			response.url().endsWith("/__sites/projects") &&
			response.request().method() === "POST"
	);
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	const createdResponse = await creation;
	expect(createdResponse.status()).toBe(201);
	const created = runtimeSiteSchema.parse(await createdResponse.json());
	await page.getByRole("button", { name: "Design", exact: true }).click();
	const canvas = page.frameLocator('iframe[title="Design canvas"]');
	await canvas
		.getByRole("heading", { name: "Design retry cafe", exact: true })
		.click();
	const inspectorText = page.getByLabel("Text", { exact: true });
	await inspectorText.fill("Persisted cafe and books");
	await inspectorText.blur();
	await expect(
		canvas.getByRole("heading", {
			name: "Persisted cafe and books",
			exact: true,
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Source", exact: true }).click();
	const draft = await page.getByLabel("HTML source").inputValue();
	expect(draft).toContain("Persisted cafe and books");
	expect(draft).not.toContain("data-ryu-node");
	await page.getByRole("button", { name: "Design", exact: true }).click();
	const writes: SiteDataValue[] = [];
	const state = failures.get(page);
	if (!state) {
		throw new Error("Design guards are missing.");
	}
	state.expectedRefusal = `/__sites/projects/${created.id}/versions`;
	await page.route(
		`**/__sites/projects/${created.id}/versions`,
		async (route) => {
			if (route.request().method() !== "POST") {
				await route.fallback();
				return;
			}
			writes.push(route.request().postDataJSON());
			if (writes.length === 1) {
				await route.fulfill({
					status: 503,
					json: {
						error: {
							message:
								"Version storage temporarily unavailable. Retry this save.",
						},
					},
				});
				return;
			}
			await route.fallback();
		}
	);
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Version storage temporarily unavailable. Retry this save."
	);
	expect(writes).toEqual([
		{
			html: draft,
			message: created.prompt,
			expectedRevision: created.revision,
		},
	]);
	await expect(
		canvas.getByRole("heading", {
			name: "Persisted cafe and books",
			exact: true,
		})
	).toBeVisible();
	const beforeResponse = await page.request.get(
		"/__sites/projects?scope=owned"
	);
	expect(beforeResponse.status()).toBe(200);
	const before = z
		.array(runtimeSiteSchema)
		.parse(await beforeResponse.json())
		.find((site) => site.id === created.id);
	expect(before?.versions).toHaveLength(0);
	expect(before?.deploymentId).toBeNull();
	expect(before?.revision).toBe(created.revision);
	await screenshot(page, "sites-design-refused-save-retained-draft.png");
	const savedResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/__sites/projects/${created.id}/versions`) &&
			response.request().method() === "POST"
	);
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	expect((await savedResponse).status()).toBe(201);
	await expect(
		page.getByText("Version saved. The deployed version has not changed.", {
			exact: true,
		})
	).toBeVisible();
	expect(writes).toEqual([writes[0], writes[0]]);
	const readResponse = await page.request.get("/__sites/projects?scope=owned");
	expect(readResponse.status()).toBe(200);
	const persisted = z
		.array(runtimeSiteSchema)
		.parse(await readResponse.json())
		.find((site) => site.id === created.id);
	expect(persisted?.versions).toHaveLength(1);
	expect(persisted?.deploymentId).toBeNull();
	if (!persisted?.versions[0]) {
		throw new Error("Saved version missing from real sidecar readback.");
	}
	const artifactResponse = await page.request.get(
		`/__sites/projects/${created.id}/versions/${persisted.versions[0].id}`
	);
	expect(artifactResponse.status()).toBe(200);
	expect(
		z.object({ html: z.string() }).parse(await artifactResponse.json()).html
	).toBe(draft);
	await page.reload();
	const card = page.locator("section").filter({
		has: page.getByRole("heading", {
			name: "Design retry cafe",
			exact: true,
		}),
	});
	await card.getByRole("button", { name: "Open site", exact: true }).click();
	await page.getByRole("button", { name: "Design", exact: true }).click();
	await expect(
		canvas.getByRole("heading", {
			name: "Persisted cafe and books",
			exact: true,
		})
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	expect(writes).toHaveLength(2);
	await screenshot(page, "sites-design-retry-persisted-reload.png");
});
