import { describe, expect, test } from "bun:test";
import { resetActionTask } from "./reset-action.ts";

describe("reset action task", () => {
	test("names the selected provider and checks account evidence first", () => {
		const task = resetActionTask("codex");
		expect(task).toContain("Codex");
		expect(task).toContain("provider id “codex”");
		expect(task).toContain("future automatic reset");
		expect(task).toContain("redeemAuthorized");
	});

	test("keeps providers without a redemption action fail-closed", () => {
		const task = resetActionTask("claude");
		expect(task).toContain("Claude Code");
		expect(task).toContain("guessing an endpoint");
		expect(task).toContain("status (scheduled, redeemed, or blocked)");
	});
});
