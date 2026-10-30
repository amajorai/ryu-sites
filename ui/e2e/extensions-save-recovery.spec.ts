import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
	type APIRequestContext,
	expect,
	type Page,
	type TestInfo,
	test,
} from "@playwright/test";
import { z } from "zod";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
import type { SiteExtensions } from "../../sidecar/src/extensions.ts";
import { siteExtensions } from "../../sidecar/src/extensions.ts";
import { runtimeSiteSchema } from "../../sidecar/src/site-records.ts";
import {
	extensionsEvidenceSchema,
	extensionsWriteSchema,
} from "./fixture-records.ts";

const host = "http://127.0.0.1:8441";
const visitor = "http://127.0.0.1:8442";
interface Write {
	expectedRevision: number;
	extensions: SiteExtensions;
}
interface Call {
	body?: SiteDataValue;
	method: string;
	ownerBearerForwarded: boolean;
	path: string;
	status?: number;
}
interface Evidence {
	connectorInvocations: number;
	managementCalls: Call[];
	unknownRequests: string[];
}

async function readSite(request: APIRequestContext): Promise<RuntimeSite> {
	const response = await request.get(`${host}/__sites/projects?scope=owned`);
	expect(response.status()).toBe(200);
	const sites = z.array(runtimeSiteSchema).parse(await response.json());
	expect(sites).toHaveLength(1);
	const [onlySite] = sites;
	if (!onlySite) {
		throw new Error("Expected exactly one isolated Sites project");
	}
	return onlySite;
}
async function published(
	request: APIRequestContext,
	id: string
): Promise<SiteExtensions> {
	const response = await request.get(
		`${host}/__sites/projects/${id}/extensions`
	);
	expect(response.status()).toBe(200);
	return z.object({ published: siteExtensions }).parse(await response.json())
		.published;
}
async function events(request: APIRequestContext): Promise<Evidence> {
	const response = await request.get(`${host}/__proof/events`);
	expect(response.status()).toBe(200);
	return extensionsEvidenceSchema.parse(await response.json());
}
async function capture(
	page: Page,
	info: TestInfo,
	name: string
): Promise<void> {
	const directory =
		process.env.RYU_SITES_EXTENSIONS_PROOF_DIR ??
		info.outputPath("product-proof");
	await mkdir(directory, { recursive: true });
	const body = await page.screenshot({
		path: path.join(directory, `${name}.png`),
		fullPage: true,
		animations: "disabled",
	});
	await info.attach(name, { body, contentType: "image/png" });
}
async function expectMcpUnpublished(
	request: APIRequestContext,
	id: string
): Promise<void> {
	const response = await request.post(`${visitor}/sites/${id}/mcp`, {
		headers: { authorization: "Bearer sites-proof-reader" },
		data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
	});
	expect(response.status()).toBe(404);
	expect(await response.json()).toMatchObject({
		error: {
			code: "disabled",
			message: "MCP tools are not published for this Site",
		},
	});
}

test("Extensions refuses a held save, retries the exact draft, and publishes tools only after version deployment", async ({
	page,
	request,
}, info) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	const baseline = await readSite(request);
	const baselinePublished = await published(request, baseline.id);
	const artifactResponse = await request.get(
		`${host}/__sites/projects/${baseline.id}/versions/initial`
	);
	expect(artifactResponse.status()).toBe(200);
	const initialArtifact = z
		.object({ html: z.string() })
		.parse(await artifactResponse.json());
	expect(baseline.settings.extensions).toEqual({
		mcp: false,
		ui: false,
		tools: [],
		connections: [],
	});
	expect(baselinePublished).toEqual(baseline.settings.extensions);
	await expectMcpUnpublished(request, baseline.id);
	await page.goto(host);
	await page.getByRole("button", { name: "Open site", exact: true }).click();
	await page.getByRole("button", { name: "Extensions", exact: true }).click();
	await page
		.getByRole("switch", { name: "Enable MCP tools", exact: true })
		.click();
	await page
		.getByRole("switch", { name: "Show Site UI in chat", exact: true })
		.click();
	await page.getByLabel("Tool name", { exact: true }).fill("list_notes");
	await page
		.getByLabel("Tool description", { exact: true })
		.fill("List my saved notes");
	await page.getByLabel("Tool collection", { exact: true }).fill("notes");
	await page.getByRole("button", { name: "Add tool", exact: true }).click();
	await page.getByRole("switch", { name: "Task tracker", exact: true }).click();
	const draft: SiteExtensions = {
		mcp: true,
		ui: true,
		tools: [
			{
				name: "list_notes",
				description: "List my saved notes",
				operation: "records.list",
				collection: "notes",
			},
		],
		connections: ["tasks"],
	};
	const expected: Write = {
		expectedRevision: baseline.revision,
		extensions: draft,
	};
	const attempts: Write[] = [];
	let releaseRefusal: (() => void) | undefined;
	const heldRefusal = new Promise<void>((resolve) => {
		releaseRefusal = resolve;
	});
	await page.route(
		`**/__sites/projects/${baseline.id}/extensions`,
		async (route) => {
			if (route.request().method() === "GET") {
				await route.continue();
				return;
			}
			expect(route.request().method()).toBe("PUT");
			expect(route.request().headers().origin).toBe(host);
			expect(route.request().headers().authorization).toBeUndefined();
			attempts.push(
				extensionsWriteSchema.parse(route.request().postDataJSON())
			);
			if (attempts.length === 1) {
				await heldRefusal;
				await route.fulfill({
					status: 503,
					json: {
						error: {
							code: "unavailable",
							message: "Extensions save temporarily unavailable",
						},
					},
				});
			} else {
				expect(attempts.length).toBe(2);
				await route.continue();
			}
		}
	);
	const save = page.getByRole("button", {
		name: "Save extensions",
		exact: true,
	});
	try {
		await save.click();
		await expect.poll(() => attempts.length).toBe(1);
		expect(attempts).toEqual([expected]);
		await expect(save).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Remove list_notes", exact: true })
		).toBeDisabled();
		expect(await readSite(request)).toEqual(baseline);
		expect(await published(request, baseline.id)).toEqual(baselinePublished);
		releaseRefusal?.();
		await expect(page.getByRole("alert")).toContainText(
			"Extensions save temporarily unavailable"
		);
		await expect(save).toBeEnabled();
		await expect(page.getByText("list_notes", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("switch", { name: "Enable MCP tools", exact: true })
		).toBeChecked();
		await expect(
			page.getByRole("switch", { name: "Task tracker", exact: true })
		).toBeChecked();
		await expect(
			page.getByText(
				"Extensions saved. Save and deploy a new version to activate them.",
				{ exact: true }
			)
		).toHaveCount(0);
		expect(await readSite(request)).toEqual(baseline);
		await expectMcpUnpublished(request, baseline.id);
		await capture(page, info, "extensions-save-refused-retry-ready");
		const savedResponse = page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				response.url().endsWith(`/projects/${baseline.id}/extensions`) &&
				response.status() === 200
		);
		await save.click();
		await savedResponse;
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(page.getByText("list_notes", { exact: true })).toBeVisible();
		expect(attempts).toEqual([expected, expected]);
		const saved = await readSite(request);
		expect(saved.settings.extensions).toEqual(draft);
		expect(saved.revision).toBe(baseline.revision + 1);
		expect(saved.settings).toEqual({ ...baseline.settings, extensions: draft });
		expect(saved.deploymentId).toBe(baseline.deploymentId);
		expect(saved.versions).toEqual(baseline.versions);
		expect(await published(request, baseline.id)).toEqual(baselinePublished);
		await expectMcpUnpublished(request, baseline.id);
		await page.reload();
		await page.getByRole("button", { name: "Open site", exact: true }).click();
		await page.getByRole("button", { name: "Extensions", exact: true }).click();
		await expect(page.getByText("list_notes", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("switch", { name: "Task tracker", exact: true })
		).toBeChecked();
		await page
			.getByRole("button", { name: "Save version", exact: true })
			.click();
		await expect(
			page.getByText("Version saved. The deployed version has not changed.", {
				exact: true,
			})
		).toBeVisible();
		const versioned = await readSite(request);
		expect(versioned.revision).toBe(saved.revision + 1);
		expect(versioned.versions).toHaveLength(baseline.versions.length + 1);
		expect(versioned.deploymentId).toBe(baseline.deploymentId);
		expect(await published(request, baseline.id)).toEqual(baselinePublished);
		await expectMcpUnpublished(request, baseline.id);
		const newest = versioned.versions.at(-1);
		expect(newest).toBeDefined();
		if (!newest) {
			throw new Error("Expected the newly saved Sites version");
		}
		// The baseline version is already deployed/disabled. The new version is
		// the sole enabled deployment action; select by that actual state.
		const enabledDeploy = page
			.locator("button:not([disabled])")
			.filter({ hasText: /^Deploy version$/ });
		await expect(enabledDeploy).toHaveCount(1);
		await enabledDeploy.click();
		await expect(
			page.getByText(
				"Deployment selected. Access follows this Site’s sharing settings.",
				{ exact: true }
			)
		).toBeVisible();
		const deployed = await readSite(request);
		expect(deployed.deploymentId).toBe(newest.id);
		expect(deployed.revision).toBe(versioned.revision + 1);
		expect(await published(request, baseline.id)).toEqual(draft);
		const anonymous = await request.post(
			`${visitor}/sites/${baseline.id}/mcp`,
			{ data: { jsonrpc: "2.0", id: 2, method: "tools/list" } }
		);
		expect(anonymous.status()).toBe(401);
		const rpc = await request.post(`${visitor}/sites/${baseline.id}/mcp`, {
			headers: { authorization: "Bearer sites-proof-reader" },
			data: { jsonrpc: "2.0", id: 3, method: "tools/list" },
		});
		expect(rpc.status()).toBe(200);
		const tools = z
			.object({
				result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
			})
			.parse(await rpc.json()).result.tools;
		expect(tools.map((tool) => tool.name)).toEqual([
			"list_notes",
			"ryu_site_context",
		]);
		await page.getByRole("button", { name: "Extensions", exact: true }).click();
		await expect(
			page.getByText("Published MCP plugin", { exact: true })
		).toBeVisible();
		await capture(page, info, "extensions-save-retry-published-tools");
		const evidence = await events(request);
		expect(evidence.unknownRequests).toEqual([]);
		expect(evidence.connectorInvocations).toBe(0);
		expect(
			evidence.managementCalls.every((call) => call.ownerBearerForwarded)
		).toBe(true);
		expect(
			evidence.managementCalls.filter((call) => call.method === "PUT")
		).toEqual([
			{
				method: "PUT",
				path: `/projects/${baseline.id}/extensions`,
				body: expected,
				ownerBearerForwarded: true,
				status: 200,
			},
		]);
		const writes = evidence.managementCalls.filter(
			(call) => call.method === "POST"
		);
		expect(writes).toHaveLength(2);
		expect(writes[0]).toEqual({
			method: "POST",
			path: `/projects/${baseline.id}/versions`,
			status: 201,
			ownerBearerForwarded: true,
			body: {
				html: initialArtifact.html,
				expectedRevision: saved.revision,
				message: "Saved from Sites",
			},
		});
		expect(writes[1]).toEqual({
			method: "POST",
			path: `/projects/${baseline.id}/deploy`,
			body: { versionId: newest.id, expectedRevision: versioned.revision },
			ownerBearerForwarded: true,
			status: 200,
		});
		expect(browserErrors).toEqual([]);
	} finally {
		releaseRefusal?.();
	}
});
