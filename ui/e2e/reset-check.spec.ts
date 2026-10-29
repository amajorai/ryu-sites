import { expect, test } from "@playwright/test";

test("editor HTML cannot run owner checks; Companion confirms and keeps the report", async ({
	page,
	context,
	request,
}) => {
	const proof = await (
		await request.get("http://127.0.0.1:8451/__proof?reset=1")
	).json();
	await context.addCookies([
		{ name: "reset-proof", value: "owner", url: proof.visitorUrl },
	]);
	const visitor = await context.newPage();
	await visitor.goto(proof.visitorUrl);
	await expect(
		visitor.getByText("Visitor requests refused: 403, 403")
	).toBeVisible();
	await visitor.addScriptTag({ url: `${proof.visitorUrl}/_ryu/runtime.js` });
	expect(
		await visitor.evaluate(
			"RyuSite.requestReset('copilot').then(() => 'unexpected success', error => error.message)"
		)
	).toBe("Run reset checks from Ryu Sites Settings.");
	expect(
		(await (await request.get("http://127.0.0.1:8451/__proof")).json()).calls
	).toEqual([]);
	await page.goto("http://127.0.0.1:8451");
	await page.getByRole("button", { name: "Open site", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Check Codex", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("Check Codex reset?", { exact: true })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		(await (await request.get("http://127.0.0.1:8451/__proof")).json()).calls
	).toEqual([]);
	await page.getByRole("button", { name: "Check Codex", exact: true }).click();
	await dialog
		.getByRole("button", { name: "Run account check", exact: true })
		.click();
	await expect(
		page.getByText(
			"codex: scheduled. Connected-account reset is tomorrow. No reset was redeemed.",
			{ exact: true }
		)
	).toBeVisible();
	expect(
		(await (await request.get("http://127.0.0.1:8451/__proof")).json()).calls
	).toEqual(["codex"]);
	await expect(visitor.locator("body")).not.toContainText(
		"Connected-account reset"
	);
	const proofDirectory = process.env.RYU_SITES_PROOF_DIR;
	if (!proofDirectory) {
		throw new Error(
			"Set RYU_SITES_PROOF_DIR to the evidence staging directory."
		);
	}
	await page.screenshot({
		path: `${proofDirectory}/settings.png`,
		fullPage: true,
		animations: "disabled",
	});
	await page.setViewportSize({ width: 430, height: 932 });
	await page.screenshot({
		path: `${proofDirectory}/settings-narrow.png`,
		fullPage: true,
		animations: "disabled",
	});
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.screenshot({
		path: `${proofDirectory}/settings-narrow-dark.png`,
		fullPage: true,
		animations: "disabled",
	});
});
