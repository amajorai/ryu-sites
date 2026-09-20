import { expect, test } from "@playwright/test";

test("public security page explains controls and renders at desktop and mobile widths", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
 // The public page needs only the anonymous session projection; the identity backend is not part of this visual proof.
 await page.route("**/api/auth/get-session*", route => route.fulfill({status:200,contentType:"application/json",body:"null",headers:{"access-control-allow-origin":"http://127.0.0.1:18431","access-control-allow-credentials":"true"}}));
	await page.goto(process.env.RYU_SECURITY_PROOF_URL ?? "http://127.0.0.1:18431/security", { waitUntil: "domcontentloaded" });
	const content = page.getByTestId("security-page");
 await expect(page.getByRole("button", {name:"Sign In",exact:true})).toBeVisible();
	await expect(content.getByRole("heading", { level: 1 })).toHaveText("Security starts with the defaults.");
	await expect(content.getByRole("link", { name: "Contact Ryu security" })).toHaveAttribute("href", /^mailto:amajorhq@gmail.com/);
	for (const name of ["Protections built into the runtime", "Know where your data goes.", "Report a security issue"]) { const heading = content.getByRole("heading", { name, exact: true }); await expect(heading).toBeVisible(); await heading.scrollIntoViewIfNeeded(); }
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path: "../../../docs/proof/security-landing-desktop.png", fullPage: true, animations: "disabled" });
	await page.setViewportSize({ width: 390, height: 844 });
	for (const name of ["Protections built into the runtime", "Know where your data goes.", "Report a security issue"]) { const heading = content.getByRole("heading", { name, exact: true }); await expect(heading).toBeVisible(); await heading.scrollIntoViewIfNeeded(); }
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect.poll(() => content.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: "../../../docs/proof/security-landing-mobile.png", fullPage: true, animations: "disabled" });
});
