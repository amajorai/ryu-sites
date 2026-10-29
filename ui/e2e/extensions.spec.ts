import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const proofPath = (name: string) =>
	fileURLToPath(new URL(`../../../../docs/proof/${name}`, import.meta.url));
test("publish Site tools and complete visitor consent and a connected read", async ({
	page,
	context,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.stack || error.message));
	await page.goto("http://127.0.0.1:8441");
	await page.getByRole("button", { name: "Open site", exact: true }).click();
	await page.getByRole("button", { name: "Extensions", exact: true }).click();
	await page.getByRole("switch", { name: "Enable MCP tools" }).click();
	await page.getByRole("switch", { name: "Show Site UI in chat" }).click();
	await page.getByLabel("Tool name", { exact: true }).fill("list_todos");
	await page
		.getByLabel("Tool description", { exact: true })
		.fill("List my saved tasks");
	await page.getByLabel("Tool collection", { exact: true }).fill("todos");
	await page.getByRole("button", { name: "Add tool", exact: true }).click();
	await page.getByRole("switch", { name: "Task tracker" }).click();
	await page
		.getByRole("button", { name: "Save extensions", exact: true })
		.click();
	await expect(page.getByText("list_todos", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await page
		.getByRole("button", { name: "Deploy version", exact: true })
		.filter({ visible: true })
		.first()
		.click();
	await page.getByRole("button", { name: "Extensions", exact: true }).click();
	await expect(
		page.getByText("Published MCP plugin", { exact: true })
	).toBeVisible();
	await expect(page.getByLabel("MCP endpoint")).toHaveValue(
		/^http:\/\/127\.0\.0\.1:8442\/sites\/[^/]+\/mcp$/
	);
	await page
		.getByRole("button", { name: "Install plugin", exact: true })
		.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Plugin installed." })
	).toBeVisible();
	await page.screenshot({
		path: proofPath("sites-extensions-desktop.png"),
		fullPage: true,
	});
	await context.addCookies([
		{
			name: "sites-proof",
			value: "reader",
			url: "http://team-task-board.localhost:8442",
			httpOnly: true,
		},
	]);
	const visitor = await context.newPage();
	visitor.on("pageerror", (error) => errors.push(error.stack || error.message));
	await visitor.goto("http://team-task-board.localhost:8442/");
	await visitor.getByRole("button", { name: "Refresh my tasks" }).click();
	await expect(visitor.getByRole("status")).toContainText("Review and allow");
	await visitor
		.getByRole("button", { name: "Review connection permissions" })
		.click();
	await expect(
		visitor.getByRole("heading", { name: "Allow Task tracker?" })
	).toBeVisible();
	await visitor
		.getByRole("button", { name: "Allow connection", exact: true })
		.click();
	await expect(
		visitor.getByRole("heading", { name: "Team task board" })
	).toBeVisible();
	await visitor.getByRole("button", { name: "Refresh my tasks" }).click();
	await expect(visitor.getByRole("status")).toHaveText(
		"Tasks loaded from your account."
	);
	await expect(visitor.locator("#tasks")).toContainText("reader@example.com");
	await visitor.screenshot({
		path: proofPath("sites-extensions-visitor.png"),
		fullPage: true,
	});
	const saved = await visitor.evaluate(async () => {
		const response = await fetch("/_ryu/records/todos/first", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "Read the launch checklist" }),
		});
		return response.status;
	});
	expect(saved).toBe(200);
	const rpc = await request.post("http://team-task-board.localhost:8442/mcp", {
		headers: { authorization: "Bearer sites-proof-reader" },
		data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
	});
	expect(rpc.ok()).toBe(true);
	expect((await rpc.json()).result.tools[0].name).toBe("list_todos");
	const resourceList = await request.post(
		"http://team-task-board.localhost:8442/mcp",
		{
			headers: { authorization: "Bearer sites-proof-reader" },
			data: { jsonrpc: "2.0", id: 2, method: "resources/list" },
		}
	);
	const uri = (await resourceList.json()).result.resources[0].uri;
	const resource = await request.post(
		"http://team-task-board.localhost:8442/mcp",
		{
			headers: { authorization: "Bearer sites-proof-reader" },
			data: {
				jsonrpc: "2.0",
				id: 3,
				method: "resources/read",
				params: { uri },
			},
		}
	);
	const widgetHtml = (await resource.json()).result.contents[0].text;
	const widgetHost = await context.newPage();
	widgetHost.on("pageerror", (error) =>
		errors.push(error.stack || error.message)
	);
	await widgetHost.goto("http://127.0.0.1:8441/");
	await widgetHost.evaluate((html) => {
		window.addEventListener("message", async (event) => {
			const frame = document.querySelector<HTMLIFrameElement>(
				'iframe[title="Site MCP App"]'
			);
			if (
				event.source !== frame?.contentWindow ||
				event.data?.jsonrpc !== "2.0"
			) {
				return;
			}
			if (event.data.method === "ui/initialize") {
				frame?.contentWindow?.postMessage(
					{
						jsonrpc: "2.0",
						id: event.data.id,
						result: {
							protocolVersion: "2026-01-26",
							hostInfo: { name: "proof", version: "1" },
							hostContext: {},
							hostCapabilities: { serverTools: {} },
						},
					},
					"*"
				);
			}
			if (event.data.method === "tools/call") {
				const response = await fetch("/__widget-rpc", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: event.data.id,
						method: "tools/call",
						params: event.data.params,
					}),
				});
				frame?.contentWindow?.postMessage(await response.json(), "*");
			}
		});
		const frame = document.createElement("iframe");
		frame.title = "Site MCP App";
		frame.srcdoc = html;
		frame.style.cssText = "width:100%;height:620px;border:1px solid #ddd";
		document.body.replaceChildren(frame);
	}, widgetHtml);
	const widget = widgetHost.frameLocator('iframe[title="Site MCP App"]');
	await expect(
		widget.getByRole("heading", { name: "Team task board" })
	).toBeVisible();
	await widget.getByRole("button", { name: "Refresh saved tasks" }).click();
	await expect(widget.getByRole("status")).toHaveText(
		"Saved tasks loaded from your account."
	);
	await expect(widget.locator("#tasks")).toContainText(
		"Read the launch checklist"
	);
	await widgetHost.locator('iframe[title="Site MCP App"]').screenshot({
		path: proofPath("sites-extensions-mcp-app.png"),
		animations: "disabled",
	});
	await widgetHost.close();
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await page.screenshot({
		path: proofPath("sites-extensions-dark.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: proofPath("sites-extensions-mobile.png"),
		fullPage: true,
		animations: "disabled",
	});
	expect(errors).toEqual([]);
});
