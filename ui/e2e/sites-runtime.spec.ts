import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { z } from "zod";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
import { runtimeSiteSchema } from "../../sidecar/src/site-records.ts";
import { installSitesFixtureCodecs } from "./fixture-codec-loader.ts";
import { sitesCallsSchema } from "./fixture-records.ts";

const EVIDENCE_DIRECTORY = path.resolve(
	import.meta.dirname,
	"../../../../docs/proof/test-coverage-sweep-20260924/evidence/sites"
);
const DESCRIPTION = "Find clear answers in your team's guides.";

interface SitesCall {
	body?: SiteDataValue;
	method: string;
	path: string;
	response?: unknown;
	status: number;
}

async function installLocalHostBridge(
	page: Page,
	modelResponses: string[] = []
): Promise<void> {
	await page.addInitScript((responses) => {
		const modelCalls: SiteDataValue[] = [];
		Reflect.set(window, "__sitesModelCalls", modelCalls);
		Reflect.set(window, "ryu", {
			app: {
				request: async (input: {
					body?: SiteDataValue;
					method?: "DELETE" | "GET" | "POST" | "PUT";
					path: string;
				}) => {
					const method = input.method ?? "GET";
					const response = await fetch(
						`/__sites${input.path}`,
						(() => {
							const value0 = {
								method,
								headers: (() => {
									const value0 = {};
									const value1 =
										input.body === undefined
											? value0
											: Object.assign(value0, {
													"content-type": "application/json",
												});
									return value1;
								})(),
							};
							const value1 =
								input.body === undefined
									? value0
									: Object.assign(value0, { body: JSON.stringify(input.body) });
							return value1;
						})()
					);
					const result = window.__sitesFixtureDecoders.value(
						await response.json()
					);
					if (!response.ok) {
						throw new Error(
							window.__sitesFixtureDecoders.message(result) ??
								`Sites request ${method} ${input.path} failed with ${response.status}`
						);
					}
					return result;
				},
			},
			model: {
				complete: async (input: { prompt: string; system: string }) => {
					modelCalls.push(input);
					const response = responses.shift();
					if (response === undefined) {
						throw new Error("The local model fixture has no response queued.");
					}
					return response;
				},
			},
		});
	}, modelResponses);
}

async function createSiteInUi(
	page: Page,
	{
		name,
		slug,
		template = "help-center",
		prompt = DESCRIPTION,
	}: { name: string; slug: string; template?: string; prompt?: string }
): Promise<RuntimeSite> {
	await page.getByRole("button", { name: "New site", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Site name", { exact: true }).fill(name);
	await dialog.getByLabel("URL name", { exact: true }).fill(slug);
	await dialog.getByLabel("Description", { exact: true }).fill(prompt);
	if (template !== "help-center") {
		await dialog.getByRole("combobox", { name: "Template" }).click();
		await page.getByRole("option", { name: template, exact: true }).click();
	}
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(
		page.getByText("Describe your website", { exact: true })
	).toBeVisible();
	const call = (await sitesCalls(page)).find(
		(candidate) =>
			candidate.method === "POST" &&
			candidate.path === "/projects" &&
			z
				.union([z.object({ slug: z.string().optional() }), z.undefined()])
				.parse(candidate.body)?.slug === slug
	);
	if (!(call?.response && runtimeSiteSchema.safeParse(call.response).success)) {
		throw new Error(`Sites did not return the created project ${slug}.`);
	}
	return runtimeSiteSchema.parse(call.response);
}

async function sitesCalls(page: Page): Promise<SitesCall[]> {
	return sitesCallsSchema.parse(
		await page.evaluate(async () => {
			const response = await fetch("/__proof/requests");
			if (!response.ok) {
				throw new Error("Sites did not expose its local request trace.");
			}
			return window.__sitesFixtureDecoders.calls(await response.json());
		})
	);
}

async function capture(
	page: Page,
	name: string,
	testInfo: TestInfo
): Promise<void> {
	await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
	const imagePath = path.join(EVIDENCE_DIRECTORY, `${name}.png`);
	const image = await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: imagePath,
	});
	await testInfo.attach(`${name}.png`, {
		body: image,
		contentType: "image/png",
	});
}

test("Sites creates, versions, deploys, secures, and takes a local site offline", async ({
	page,
	context,
}, testInfo) => {
	const errors: string[] = [];
	const slug = `northstar-${Date.now()}`;
	const domain = `help-${Date.now()}.northstar.example`;
	page.on("pageerror", (error) => errors.push(error.message));
	await installLocalHostBridge(page);
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "New site", exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "New site", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Site name", { exact: true })
		.fill("Northstar Knowledge");
	await dialog.getByLabel("URL name", { exact: true }).fill(slug);
	await dialog.getByLabel("Description", { exact: true }).fill(DESCRIPTION);
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(
		page.getByText("Describe your website", { exact: true })
	).toBeVisible();
	const preview = page.frameLocator('iframe[title="Website preview"]');
	await expect(
		preview.getByRole("heading", { name: "Northstar Knowledge" })
	).toBeVisible();
	await preview.getByLabel("Search articles").fill("import");
	await expect(
		preview.getByRole("heading", { name: "Getting started" })
	).toBeVisible();
	await capture(page, "sites-runtime-builder", testInfo);

	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await expect(
		page.getByText("Version saved. The deployed version has not changed.")
	).toBeVisible();
	await page
		.getByRole("button", { name: "Deploy version", exact: true })
		.click();
	const visitorLink = page
		.getByRole("link")
		.filter({ hasText: `${slug}.localhost:` });
	await expect(visitorLink).toBeVisible();
	const visitorAddress = await visitorLink.getAttribute("href");
	if (!visitorAddress) {
		throw new Error("The Sites visitor URL was not returned after deploy.");
	}
	const visitor = await context.newPage();
	await visitor.goto(visitorAddress);
	await expect(
		visitor.getByRole("heading", { name: "This site is private" })
	).toBeVisible();

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("combobox", { name: "Who can visit" }).click();
	await page.getByRole("option", { name: "Anyone on the internet" }).click();
	await page
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	await expect(
		page.getByRole("combobox", { name: "Who can visit" })
	).toContainText("Anyone on the internet");
	await visitor.reload();
	await expect(
		visitor.getByRole("heading", { name: "Northstar Knowledge" })
	).toBeVisible();
	await visitor.locator("#documents").setInputFiles({
		buffer: Buffer.from(
			"Refund policy: customers can request a refund within 30 days."
		),
		mimeType: "text/markdown",
		name: "refunds.md",
	});
	await expect(visitor.getByRole("status")).toContainText("2 articles ready");
	await visitor.getByLabel("Search articles").fill("refund");
	await expect(
		visitor.getByRole("heading", { name: "refunds.md" })
	).toBeVisible();
	await visitor.reload();
	await visitor.getByLabel("Search articles").fill("refund");
	await expect(
		visitor.getByText(
			"Refund policy: customers can request a refund within 30 days."
		)
	).toBeVisible();
	await capture(visitor, "sites-runtime-visitor", testInfo);

	await page.getByPlaceholder("help.example.com").fill(domain);
	await page.getByRole("button", { name: "Add domain", exact: true }).click();
	await expect(page.getByText("pending dns", { exact: true })).toBeVisible();
	await capture(page, "sites-runtime-settings", testInfo);
	await page.getByRole("button", { name: "Analytics", exact: true }).click();
	await expect(page.getByRole("cell").first()).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await capture(page, "sites-runtime-mobile", testInfo);
	await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
	await page.emulateMedia({ colorScheme: "dark" });
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await expect(
		page.getByRole("button", { name: "All sites", exact: true })
	).toHaveCSS("color", "oklch(0.985 0 0)");
	await capture(page, "sites-runtime-dark", testInfo);
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page
		.getByRole("button", { name: "Take site offline", exact: true })
		.click();
	await visitor.reload();
	await expect(visitor.locator("body")).toContainText("Site is not deployed");
	await page.getByRole("button", { name: "All sites", exact: true }).click();
	const siteCard = page
		.locator("section")
		.filter({ hasText: "Northstar Knowledge" });
	await expect(
		siteCard.getByRole("button", { name: "Open site" })
	).toBeVisible();
	await siteCard.getByRole("button", { name: "Open site" }).click();
	await expect(
		page.frameLocator('iframe[title="Website preview"]').getByRole("heading", {
			name: "Northstar Knowledge",
		})
	).toBeVisible();
	await expect(errors).toEqual([]);

	const calls = await sitesCalls(page);
	const createCall = calls.find(
		(call) => call.method === "POST" && call.path === "/projects"
	);
	if (
		!(
			createCall?.response &&
			runtimeSiteSchema.safeParse(createCall.response).success
		)
	) {
		throw new Error(
			"Sites did not record a successful project creation request."
		);
	}
	const createdSite = runtimeSiteSchema.parse(createCall.response);
	const createBody = z
		.object({
			name: z.string(),
			prompt: z.string(),
			slug: z.string(),
			template: z.string(),
		})
		.parse(createCall.body);
	expect(createBody).toEqual({
		name: "Northstar Knowledge",
		prompt: DESCRIPTION,
		slug,
		template: "help-center",
	});
	const versionCall = calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === `/projects/${createdSite.id}/versions`
	);
	const versionBody = z
		.union([
			z.object({
				expectedRevision: z.number(),
				html: z.string(),
				message: z.string(),
			}),
			z.undefined(),
		])
		.parse(versionCall?.body);
	expect(versionBody).toMatchObject({
		expectedRevision: 0,
		message: DESCRIPTION,
	});
	expect(versionBody?.html).toContain("Northstar Knowledge");
	const versionResponse = z
		.union([runtimeSiteSchema, z.undefined()])
		.parse(versionCall?.response);
	const versionId = versionResponse?.versions.at(-1)?.id;
	if (!versionId) {
		throw new Error("Sites did not read back the saved version id.");
	}
	expect(
		calls.find(
			(call) =>
				call.method === "POST" &&
				call.path === `/projects/${createdSite.id}/deploy`
		)?.body
	).toEqual({ expectedRevision: 1, versionId });
	expect(
		calls.find(
			(call) =>
				call.method === "PUT" &&
				call.path === `/projects/${createdSite.id}/settings`
		)?.body
	).toMatchObject({ expectedRevision: 2, settings: { audience: "public" } });
	expect(
		calls.find(
			(call) =>
				call.method === "POST" &&
				call.path === `/projects/${createdSite.id}/domains`
		)?.body
	).toEqual({ expectedRevision: 3, host: domain });
	expect(
		calls.find(
			(call) =>
				call.method === "POST" &&
				call.path === `/projects/${createdSite.id}/unpublish`
		)?.body
	).toEqual({ expectedRevision: 4 });
});

test("duplicate URL conflicts stay inside the create dialog and can be corrected without a phantom site", async ({
	page,
}, testInfo) => {
	await installLocalHostBridge(page);
	await page.goto("/");
	const calls = await sitesCalls(page);
	const existingCreate = calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/projects" &&
			z
				.union([z.object({ name: z.string().optional() }), z.undefined()])
				.parse(call.body)?.name === "Northstar Knowledge"
	);
	const existingSlug = z
		.union([z.object({ slug: z.string().optional() }), z.undefined()])
		.parse(existingCreate?.body)?.slug;
	if (!existingSlug) {
		throw new Error(
			"The first Sites flow did not leave a project for conflict recovery."
		);
	}

	await page.getByRole("button", { name: "New site", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Site name", { exact: true })
		.fill("Duplicate Recovery");
	await dialog.getByLabel("URL name", { exact: true }).fill(existingSlug);
	await dialog
		.getByLabel("Description", { exact: true })
		.fill("Retry an occupied URL without losing the draft.");
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"This URL is already in use"
	);
	await expect(dialog).toBeVisible();
	const conflict = (await sitesCalls(page)).find(
		(call) =>
			call.method === "POST" &&
			call.path === "/projects" &&
			z
				.union([z.object({ name: z.string().optional() }), z.undefined()])
				.parse(call.body)?.name === "Duplicate Recovery"
	);
	expect(conflict?.status).toBe(409);
	await capture(page, "sites-runtime-create-conflict-visible", testInfo);

	const correctedSlug = `recovered-${Date.now()}`;
	await dialog.getByLabel("URL name", { exact: true }).fill(correctedSlug);
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Duplicate Recovery" })
	).toBeVisible();
	const duplicateAttempts = (await sitesCalls(page)).filter(
		(call) =>
			call.method === "POST" &&
			call.path === "/projects" &&
			z
				.union([z.object({ name: z.string().optional() }), z.undefined()])
				.parse(call.body)?.name === "Duplicate Recovery"
	);
	expect(duplicateAttempts.map((call) => call.status)).toEqual([409, 201]);

	await page.getByRole("button", { name: "All sites", exact: true }).click();
	const recoveredCard = page
		.locator("section")
		.filter({ hasText: "Duplicate Recovery" });
	await expect(
		recoveredCard.getByRole("button", { name: "Open site" })
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Open site" })).toHaveCount(2);
});

test("failed project reads keep an error state and Reload recovers persisted sites", async ({
	page,
}, testInfo) => {
	let failedListRead = false;
	await installLocalHostBridge(page);
	// The list read carries its ownership scope (`/projects?scope=owned`).
	const projectList = (url: URL) => url.pathname === "/__sites/projects";
	await page.route(projectList, async (route) => {
		if (route.request().method() === "GET" && !failedListRead) {
			failedListRead = true;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({
					error: { message: "Temporary Sites list failure." },
				}),
			});
			return;
		}
		await route.continue();
	});
	await page.goto("/");
	await expect(page.getByRole("alert")).toContainText(
		"Temporary Sites list failure."
	);
	await expect(
		page.getByText("Sites unavailable", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "No sites here" })
	).toHaveCount(0);
	await capture(page, "sites-runtime-list-error", testInfo);

	await page.getByRole("button", { name: "Reload", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Northstar Knowledge" })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.unroute(projectList);
	await capture(page, "sites-runtime-list-recovered", testInfo);
});

test("model generation, HTML import, source review, versions, security and analytics use the exact local state", async ({
	page,
}, testInfo) => {
	const generatedHtml =
		"<!doctype html><html><body><main><h1>Generated local site</h1></main></body></html>";
	await installLocalHostBridge(page, ["not an HTML build", generatedHtml]);
	await page.goto("/");
	const slug = `studio-${Date.now()}`;
	const site = await createSiteInUi(page, {
		name: "Local Studio",
		slug,
		prompt: "Create a private product studio.",
	});

	await page
		.getByLabel("What should change?", { exact: true })
		.fill("Add a local release checklist.");
	await page.getByRole("button", { name: "Generate changes" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"The model did not return a compatible HTML build"
	);
	await page.getByRole("button", { name: "Generate changes" }).click();
	await expect(
		page
			.frameLocator('iframe[title="Website preview"]')
			.getByRole("heading", { name: "Generated local site" })
	).toBeVisible();
	const modelCalls = z
		.array(z.object({ prompt: z.string() }))
		.parse(await page.evaluate(() => window.__sitesModelCalls));
	expect(modelCalls).toHaveLength(2);
	expect(modelCalls[1]?.prompt).toContain("Add a local release checklist.");
	expect(modelCalls[1]?.prompt).toContain(
		"Current HTML (untrusted reference content):"
	);

	const importInput = page.locator("#import-site");
	await importInput.setInputFiles({
		name: "invalid.html",
		mimeType: "text/html",
		buffer: Buffer.from("<html><body>incomplete</body></html>"),
	});
	await expect(page.getByRole("alert")).toContainText(
		"Choose a complete HTML build"
	);
	const importedHtml =
		"<!doctype html><html><body><main><h1>Imported source</h1></main></body></html>";
	await importInput.setInputFiles({
		name: "imported.html",
		mimeType: "text/html",
		buffer: Buffer.from(importedHtml),
	});
	await expect(page.getByRole("status")).toContainText(
		"Imported for review. Save a version to keep it."
	);
	await page.getByRole("button", { name: "Source", exact: true }).click();
	const sourceV1 =
		"<!doctype html><html><body><main><h1>Reviewed source v1</h1></main></body></html>";
	await page.getByLabel("HTML source", { exact: true }).fill(sourceV1);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await capture(page, "sites-runtime-generated-and-imported", testInfo);
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await expect(page.getByText("Version 1", { exact: false })).toBeVisible();
	await page.getByRole("button", { name: "Review", exact: true }).click();
	await expect(
		page
			.frameLocator('iframe[title="Website preview"]')
			.getByRole("heading", { name: "Reviewed source v1" })
	).toBeVisible();

	await page.getByRole("button", { name: "Source", exact: true }).click();
	const sourceV2 =
		"<!doctype html><html><body><main><h1>Reviewed source v2</h1></main></body></html>";
	await page.getByLabel("HTML source", { exact: true }).fill(sourceV2);
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	const calls = await sitesCalls(page);
	const versions = calls.filter(
		(call) =>
			call.method === "POST" && call.path === `/projects/${site.id}/versions`
	);
	expect(versions).toHaveLength(2);
	const version1 = z
		.union([runtimeSiteSchema, z.undefined()])
		.parse(versions[0]?.response);
	const firstVersionId = version1?.versions.at(-1)?.id;
	if (!firstVersionId) {
		throw new Error("The first saved version was not returned by Sites.");
	}
	const firstVersion = page
		.getByText("Version 1", { exact: false })
		.locator("xpath=../..");
	await firstVersion
		.getByRole("button", { name: "Deploy version", exact: true })
		.click();
	const deployment = (await sitesCalls(page)).find(
		(call) =>
			call.method === "POST" && call.path === `/projects/${site.id}/deploy`
	);
	expect(deployment?.body).toEqual({
		versionId: firstVersionId,
		expectedRevision: 2,
	});

	await page.getByRole("button", { name: "Security", exact: true }).click();
	await expect(
		page.getByText("No known secret patterns detected", { exact: false })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Run check again", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await sitesCalls(page)).filter(
					(call) =>
						call.method === "GET" &&
						call.path.startsWith(`/projects/${site.id}/security?versionId=`)
				).length
		)
		.toBe(2);

	await page.getByRole("button", { name: "Analytics", exact: true }).click();
	await page.getByRole("combobox", { name: "Analytics date range" }).click();
	await page.getByRole("option", { name: "Last 30 days", exact: true }).click();
	await expect(page.getByText("No traffic yet", { exact: true })).toBeVisible();
	expect(
		(await sitesCalls(page)).some(
			(call) =>
				call.method === "GET" &&
				call.path === `/projects/${site.id}/analytics?days=30`
		)
	).toBe(true);
});

test("create cancellation, capability gates, settings, URL, domains and confirmed deletion round-trip through Sites", async ({
	page,
}, testInfo) => {
	await installLocalHostBridge(page);
	await page.goto("/");
	const initialCalls = await sitesCalls(page);
	await page.getByRole("button", { name: "New site", exact: true }).click();
	const createDialog = page.getByRole("dialog");
	const createButton = createDialog.getByRole("button", {
		name: "Create site",
		exact: true,
	});
	await expect(createButton).toBeDisabled();
	await createDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		(await sitesCalls(page)).filter(
			(call) => call.method === "POST" && call.path === "/projects"
		)
	).toEqual(
		initialCalls.filter(
			(call) => call.method === "POST" && call.path === "/projects"
		)
	);

	const slug = `reset-${Date.now()}`;
	const site = await createSiteInUi(page, {
		name: "Reset Calendar",
		slug,
		template: "reset-calendar",
		prompt: "A private account reset calendar.",
	});
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByText("Connect platform identity to enable sign-in", {
			exact: false,
		})
	).toBeVisible();
	await expect(page.getByLabel("Workspace ID")).toHaveCount(0);
	await expect(page.getByLabel("Viewer emails (one per line)")).toHaveCount(0);
	await expect(
		page.getByRole("switch", { name: "Owner reset checks" })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "AI for visitors" })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Optional visitor sign-in" })
	).toBeDisabled();
	await expect(
		page.getByPlaceholder("Retrieval service not connected", { exact: true })
	).toBeDisabled();

	await page.getByRole("combobox", { name: "Who can visit" }).click();
	await expect(
		page.getByRole("option", { name: "Invited viewers", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("option", { name: "Workspace", exact: true })
	).toBeDisabled();
	await page
		.getByRole("option", { name: "Anyone on the internet", exact: true })
		.click();
	await page.getByRole("combobox", { name: "Data runtime" }).click();
	await page
		.getByRole("option", { name: "Connected to Ryu", exact: true })
		.click();
	// Durable records stay off until a Ryu Spaces database is bound to the site.
	await expect(
		page.getByRole("switch", { name: "Durable records" })
	).toBeDisabled();
	await page.getByRole("switch", { name: "File uploads" }).click();
	await capture(page, "sites-runtime-capability-settings", testInfo);
	await page
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	const settingsCall = (await sitesCalls(page)).find(
		(call) =>
			call.method === "PUT" && call.path === `/projects/${site.id}/settings`
	);
	expect(settingsCall?.body).toMatchObject({
		expectedRevision: 0,
		settings: {
			audience: "public",
			mode: "connected",
			storage: false,
			uploads: true,
			ai: false,
			optionalSignIn: false,
			agentActions: false,
		},
	});
	await expect(
		page.getByRole("combobox", { name: "Who can visit" })
	).toContainText("Anyone on the internet");

	const renamedSlug = `${slug}-guide`;
	await page.getByLabel("Site URL name").fill(renamedSlug);
	await page.getByRole("button", { name: "Change URL", exact: true }).click();
	expect(
		(await sitesCalls(page)).find(
			(call) =>
				call.method === "PUT" && call.path === `/projects/${site.id}/url`
		)?.body
	).toEqual({ slug: renamedSlug, expectedRevision: 1 });

	const domain = `guide-${Date.now()}.example.test`;
	await page.getByPlaceholder("help.example.com").fill(domain);
	await page.getByRole("button", { name: "Add domain", exact: true }).click();
	await expect(page.getByText("pending dns", { exact: true })).toBeVisible();
	await page
		.getByRole("button", { name: "Check DNS and TLS", exact: true })
		.click();
	const checkedDomain = (await sitesCalls(page)).find(
		(call) =>
			call.method === "POST" &&
			call.path === `/projects/${site.id}/domains/check`
	);
	const checkedSite = z
		.union([runtimeSiteSchema, z.undefined()])
		.parse(checkedDomain?.response);
	expect(checkedDomain?.status).toBe(200);
	expect(checkedDomain?.body).toEqual({
		host: domain,
		expectedRevision: 3,
	});
	expect(checkedSite?.domains[0]).toMatchObject({
		host: domain,
		status: "pending_dns",
	});
	expect(checkedSite?.domains[0]?.checkedAt).not.toBeNull();
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	expect(
		(await sitesCalls(page)).some(
			(call) =>
				call.method === "DELETE" &&
				call.path === `/projects/${site.id}/domains` &&
				z
					.union([z.object({ host: z.string().optional() }), z.undefined()])
					.parse(call.body)?.host === domain
		)
	).toBe(true);

	await page.getByRole("button", { name: "Delete site", exact: true }).click();
	const deleteDialog = page.getByRole("dialog");
	await deleteDialog
		.getByLabel("Confirm site URL name", { exact: true })
		.fill(slug);
	await expect(
		deleteDialog.getByRole("button", {
			name: "Permanently delete",
			exact: true,
		})
	).toBeDisabled();
	await deleteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "All sites", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Delete site", exact: true }).click();
	const confirmDialog = page.getByRole("dialog");
	await confirmDialog
		.getByLabel("Confirm site URL name", { exact: true })
		.fill(renamedSlug);
	await confirmDialog
		.getByRole("button", { name: "Permanently delete", exact: true })
		.click();
	await expect(page.getByText("Reset Calendar", { exact: true })).toHaveCount(
		0
	);
	const deleteCall = (await sitesCalls(page)).find(
		(call) => call.method === "DELETE" && call.path === `/projects/${site.id}`
	);
	expect(deleteCall?.body).toEqual({
		slug: renamedSlug,
		expectedRevision: 5,
	});
});

test.beforeEach(async ({ page }) => {
	await installSitesFixtureCodecs(page);
});
