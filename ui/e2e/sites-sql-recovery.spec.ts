import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import {
	type SiteDataValue,
	siteDataRecordSchema,
} from "../../sidecar/src/data-values.ts";
import { runtimeSiteSchema } from "../../sidecar/src/site-records.ts";
import { installSitesFixtureCodecs } from "./fixture-codec-loader.ts";

const TOKEN = "sites-playwright-local-token";
const QUERY = "SELECT owner FROM data LIMIT 1";
const proofDirectory =
	process.env.RYU_SITES_SQL_PROOF_DIR ??
	path.join(import.meta.dirname, "evidence/sql");
interface Call {
	authorization: string | undefined;
	body: SiteDataValue;
	method: string;
	path: string;
}
function gate() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

async function openDatabase(page: Page, name: string) {
	const card = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name, exact: true }) });
	await card.getByRole("button", { name: "Open site", exact: true }).click();
	await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Database", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Ryu Spaces database", exact: true })
	).toBeVisible();
}

for (const outcome of ["success", "refusal"] as const) {
	test(`actual Sites navigation keeps B query pending after old A ${outcome} and shows only B results`, async ({
		page,
		request,
	}, testInfo) => {
		const suffix = Date.now();
		const seeded: RuntimeSite[] = [];
		for (const label of ["A", "B"]) {
			const response = await request.post("/__sites/projects", {
				data: {
					name: `SQL ${outcome} Site ${label}`,
					slug: `sql-${label.toLowerCase()}-${suffix}`,
					template: "dashboard",
					prompt: "Isolated SQL selection proof",
				},
			});
			expect(response.status()).toBe(201);
			seeded.push(runtimeSiteSchema.parse(await response.json()));
		}
		const [siteA, siteB] = seeded;
		if (!(siteA && siteB)) {
			throw new Error("Both isolated Sites must exist");
		}
		const old = gate();
		const current = gate();
		const calls: Call[] = [];
		const unknown: string[] = [];
		const pageErrors: string[] = [];
		let oldDelivered = false;
		let currentDelivered = false;
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.addInitScript(
			({ token, ids }) => {
				const failures: string[] = [];
				Reflect.set(window, "__sqlUnknown", failures);
				Reflect.set(window, "ryu", {
					app: {
						request: async (input: {
							method?: string;
							path: string;
							body?: SiteDataValue;
						}) => {
							const method = input.method ?? "GET";
							const allowedRead =
								method === "GET" &&
								[
									"/projects?scope=owned",
									"/status",
									"/runtime",
									...ids.map((id) => `/projects/${id}/database`),
									...ids.map((id) => `/projects/${id}/visitors`),
								].includes(input.path) &&
								input.body === undefined;
							const allowedQuery =
								method === "POST" &&
								ids.some(
									(id) => input.path === `/projects/${id}/database/query`
								) &&
								JSON.stringify(input.body) ===
									JSON.stringify({ query: "SELECT owner FROM data LIMIT 1" });
							if (!(allowedRead || allowedQuery)) {
								failures.push(
									`${method} ${input.path} ${JSON.stringify(input.body)}`
								);
								throw new Error("Unexpected SQL proof app request");
							}
							const response = await fetch(
								`/__sites${input.path}`,
								(() => {
									const value0 = {
										method,
										headers: (() => {
											const value0 = { authorization: `Bearer ${token}` };
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
											: Object.assign(value0, {
													body: JSON.stringify(input.body),
												});
									return value1;
								})()
							);
							const result = window.__sitesFixtureDecoders.value(
								await response.json()
							);
							if (!response.ok) {
								throw new Error(
									window.__sitesFixtureDecoders.message(result) ??
										`Sites HTTP ${response.status}`
								);
							}
							return result;
						},
					},
				});
			},
			{ token: TOKEN, ids: [siteA.id, siteB.id] }
		);
		await page.route(
			(url) => url.pathname.startsWith("/__sites/"),
			async (route: Route) => {
				const incoming = route.request();
				const url = new URL(incoming.url());
				const apiPath = url.pathname.slice("/__sites".length);
				const call: Call = {
					method: incoming.method(),
					path: `${apiPath}${url.search}`,
					body: incoming.postDataJSON() ?? null,
					authorization: incoming.headers().authorization,
				};
				calls.push(call);
				if (
					call.authorization !== `Bearer ${TOKEN}` ||
					url.origin !== "http://127.0.0.1:48241"
				) {
					unknown.push(
						`Invalid SQL fixture origin/auth ${JSON.stringify(call)}`
					);
					await route.fulfill({
						status: 403,
						json: { error: { message: "Invalid proof scope" } },
					});
					return;
				}
				const metadata = [siteA.id, siteB.id].find(
					(id) => apiPath === `/projects/${id}/database`
				);
				if (metadata && call.method === "GET" && call.body === null) {
					await route.fulfill({
						json: {
							connected: true,
							records: metadata === siteA.id ? 2 : 7,
							database: {
								databaseId: `db-${metadata}`,
								spaceId: `space-${metadata}`,
							},
						},
					});
					return;
				}
				// The Database section also mounts the owner's Visitor data panel.
				const visitorRead = [siteA.id, siteB.id].some(
					(id) => apiPath === `/projects/${id}/visitors`
				);
				if (visitorRead && call.method === "GET" && call.body === null) {
					await route.fulfill({ json: { visitors: [], audit: [] } });
					return;
				}
				const queried = [siteA.id, siteB.id].find(
					(id) => apiPath === `/projects/${id}/database/query`
				);
				if (
					queried &&
					call.method === "POST" &&
					JSON.stringify(call.body) === JSON.stringify({ query: QUERY })
				) {
					if (calls.filter((item) => item.path === call.path).length !== 1) {
						unknown.push(`Unexpected repeated SQL ${call.path}`);
						await route.fulfill({
							status: 409,
							json: { error: { message: "Duplicate proof query" } },
						});
						return;
					}
					if (queried === siteA.id) {
						await old.ready;
						await route.fulfill(
							outcome === "refusal"
								? {
										status: 403,
										json: { error: { message: "Old A SQL permission denied" } },
									}
								: {
										json: {
											columns: ["owner"],
											rows: [["PRIVATE_A"]],
											schema: [{ id: "a", label: "A private", name: "owner" }],
											truncated: false,
										},
									}
						);
						oldDelivered = true;
					} else {
						await current.ready;
						await route.fulfill({
							json: {
								columns: ["owner"],
								rows: [["CURRENT_B"]],
								schema: [{ id: "b", label: "Current B owner", name: "owner" }],
								truncated: false,
							},
						});
						currentDelivered = true;
					}
					return;
				}
				if (
					call.method === "GET" &&
					call.body === null &&
					["/projects?scope=owned", "/status", "/runtime"].includes(call.path)
				) {
					if (apiPath === "/status") {
						const real = await route.fetch();
						const status = siteDataRecordSchema.parse(await real.json());
						await route.fulfill({
							response: real,
							json: { ...status, databaseAvailable: true },
						});
					} else {
						await route.continue();
					}
					return;
				}
				unknown.push(`Unhandled SQL HTTP ${JSON.stringify(call)}`);
				await route.fulfill({
					status: 404,
					json: { error: { message: "Unknown proof route" } },
				});
			}
		);
		try {
			await page.goto("/");
			await openDatabase(page, siteA.name);
			await page.getByLabel("SQL query", { exact: true }).fill(QUERY);
			await page
				.getByRole("button", { name: "Run query", exact: true })
				.click();
			await expect
				.poll(
					() =>
						calls.filter((call) => call.path.endsWith("/database/query")).length
				)
				.toBe(1);
			await page
				.getByRole("button", { name: "All sites", exact: true })
				.click();
			await openDatabase(page, siteB.name);
			await expect(
				page.getByText("7 records in this Site database", { exact: true })
			).toBeVisible();
			await page.getByLabel("SQL query", { exact: true }).fill(QUERY);
			await page
				.getByRole("button", { name: "Run query", exact: true })
				.click();
			await expect
				.poll(
					() =>
						calls.filter((call) => call.path.endsWith("/database/query")).length
				)
				.toBe(2);
			old.release();
			await expect.poll(() => oldDelivered).toBe(true);
			await expect(
				page.getByRole("button", { name: "Running…", exact: true })
			).toBeDisabled();
			await expect(page.getByRole("alert")).toHaveCount(0);
			await expect(page.getByRole("table")).toHaveCount(0);
			current.release();
			await expect.poll(() => currentDelivered).toBe(true);
			await expect(
				page.getByRole("cell", { name: "CURRENT_B", exact: true })
			).toBeVisible();
			await expect(
				page.getByText("Current B owner:", { exact: false })
			).toBeVisible();
			await expect(page.getByRole("status")).toHaveText("1 rows");
			await expect(
				page.getByRole("heading", { name: siteB.name, exact: true })
			).toBeVisible();
			await expect(
				page.getByRole("cell", { name: "PRIVATE_A", exact: true })
			).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: "Run query", exact: true })
			).toBeEnabled();
			await expect(page.getByRole("alert")).toHaveCount(0);
			expect(calls.filter((call) => call.path.includes("/database"))).toEqual([
				{
					method: "GET",
					path: `/projects/${siteA.id}/database`,
					body: null,
					authorization: `Bearer ${TOKEN}`,
				},
				{
					method: "POST",
					path: `/projects/${siteA.id}/database/query`,
					body: { query: QUERY },
					authorization: `Bearer ${TOKEN}`,
				},
				{
					method: "GET",
					path: `/projects/${siteB.id}/database`,
					body: null,
					authorization: `Bearer ${TOKEN}`,
				},
				{
					method: "POST",
					path: `/projects/${siteB.id}/database/query`,
					body: { query: QUERY },
					authorization: `Bearer ${TOKEN}`,
				},
			]);
			expect(calls.filter((call) => call.path.endsWith("/visitors"))).toEqual(
				[siteA, siteB].map((site) => ({
					method: "GET",
					path: `/projects/${site.id}/visitors`,
					body: null,
					authorization: `Bearer ${TOKEN}`,
				}))
			);
			for (const apiPath of ["/projects?scope=owned", "/status", "/runtime"]) {
				expect(calls.filter((call) => call.path === apiPath)).toHaveLength(1);
			}
			expect(unknown).toEqual([]);
			expect(await page.evaluate(() => window.__sqlUnknown)).toEqual([]);
			expect(pageErrors).toEqual([]);
			await page.evaluate(() => document.fonts.ready);
			await mkdir(proofDirectory, { recursive: true });
			const image = await page.screenshot({
				path: path.join(proofDirectory, `sites-sql-${outcome}-current-b.png`),
				animations: "disabled",
				fullPage: true,
			});
			await testInfo.attach("completed-current-site-sql", {
				body: image,
				contentType: "image/png",
			});
			await writeFile(
				path.join(proofDirectory, `sites-sql-${outcome}-contract.json`),
				JSON.stringify(
					{
						calls,
						unknown,
						pageErrors,
						oldDelivered,
						currentDelivered,
						boundary:
							"Actual built SitesApp and real project creation/storage. Database availability/read/query and empty Visitor data replies are finite controlled Spaces transport. Real UI All sites/Open site navigation unmounts A's panel; retained-panel props race is covered separately by mounted tests. No live Spaces/Core/native proof.",
					},
					null,
					2
				)
			);
		} finally {
			old.release();
			current.release();
		}
	});
}

test.beforeEach(async ({ page }) => {
	await installSitesFixtureCodecs(page);
});
