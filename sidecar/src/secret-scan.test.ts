import { describe, expect, test } from "bun:test";
import { createSiteInput } from "./contracts.ts";
import {
	createStandaloneScanner,
	SECRET_PATTERN_NAMES,
	scanForSecrets,
} from "./secret-scan.ts";
import { starterHtml } from "./templates.ts";

// Fixtures are assembled at runtime so this file never holds a literal key.
const fakeSecrets: Record<string, string> = {
	openai_key: `const key = "sk-${"A1b2C3d4".repeat(4)}";`,
	anthropic_key: `sk-ant-${"api03-".repeat(4)}`,
	aws_access_key: `AKIA${"IOSFODNN7EXAMPLE"}`,
	aws_secret_key: `aws_secret_access_key = "${"wJalr/K7MDENG+".repeat(3).slice(0, 40)}"`,
	github_token_classic: `ghp_${"a".repeat(36)}`,
	github_token_fg: `github_pat_${"b".repeat(82)}`,
	bearer_token: `Authorization: Bearer ${"c".repeat(48)}`,
	pem_private_key: `-----BEGIN ${"PRIVATE"} KEY-----\nMIIE`,
	generic_api_key: `api_key: "${"d".repeat(24)}"`,
	db_connection: `postgres://admin:${"hunter2"}@db.example.com/app`,
	github_token_other: `gho_${"e".repeat(36)}`,
	stripe_secret_key: `${"sk"}_live_${"f".repeat(24)}`,
	slack_token: `${"xoxb"}-1234567890-abcdefghij`,
	slack_webhook: `https://hooks.slack.com/services/T${"0".repeat(8)}/B${"1".repeat(8)}/${"x".repeat(24)}`,
	google_api_key: `AIza${"g".repeat(35)}`,
	gitlab_token: `glpat-${"h".repeat(20)}`,
	npm_token: `npm_${"i".repeat(36)}`,
	sendgrid_key: `SG.${"j".repeat(22)}.${"k".repeat(43)}`,
};

describe("built-in standalone secret scanner", () => {
	test("detects every built-in credential format", () => {
		expect(Object.keys(fakeSecrets).sort()).toEqual(
			[...SECRET_PATTERN_NAMES].sort()
		);
		for (const [name, secret] of Object.entries(fakeSecrets)) {
			expect(
				scanForSecrets(`<!doctype html><script>${secret}</script>`)
			).toEqual({
				allowed: false,
				reason: `secret guardrail tripped (${name})`,
			});
		}
	});

	test("passes every starter template and ordinary page text", () => {
		for (const template of createSiteInput.shape.template.unwrap().options) {
			expect(
				scanForSecrets(starterHtml("Starter", template, "A test site"))
			).toEqual({ allowed: true, reason: null });
		}
		expect(
			scanForSecrets(
				"<!doctype html><p>Ask for an API key in Settings. Bearer tokens expire.</p>"
			).allowed
		).toBe(true);
	});
});

describe("standalone deploy scanner", () => {
	test("blocks locally without asking the Gateway", async () => {
		let calls = 0;
		const scan = createStandaloneScanner({
			gateway: { url: "https://gateway.example.com", key: "gateway-key" },
			fetchImpl: (async () => {
				calls += 1;
				return Response.json({ allowed: true, reason: null });
			}) as unknown as typeof fetch,
		});
		expect((await scan(fakeSecrets.aws_access_key ?? "")).allowed).toBe(false);
		expect(calls).toBe(0);
	});

	test("also requires a configured Gateway to allow the artifact", async () => {
		const requests: Request[] = [];
		const scan = createStandaloneScanner({
			gateway: { url: "https://gateway.example.com", key: "gateway-key" },
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(input, init));
				return Response.json({
					allowed: false,
					reason: "secret guardrail tripped (org_pattern)",
				});
			}) as unknown as typeof fetch,
		});
		expect(await scan("<!doctype html><p>clean</p>")).toEqual({
			allowed: false,
			reason: "secret guardrail tripped (org_pattern)",
		});
		const request = requests[0];
		expect(request?.url).toBe("https://gateway.example.com/v1/firewall/check");
		expect(request?.headers.get("authorization")).toBe("Bearer gateway-key");
		expect(await request?.json()).toEqual({
			text: "<!doctype html><p>clean</p>",
			checks: ["secret"],
		});
	});

	test("fails closed when the Gateway refuses or breaks its contract", async () => {
		for (const response of [
			new Response("denied", { status: 401 }),
			Response.json({ verdict: "ok" }),
		]) {
			const scan = createStandaloneScanner({
				gateway: { url: "https://gateway.example.com", key: null },
				fetchImpl: (async () => response) as unknown as typeof fetch,
			});
			await expect(scan("<!doctype html><p>clean</p>")).rejects.toThrow();
		}
	});

	test("passes a clean artifact with only the built-in patterns", async () => {
		const scan = createStandaloneScanner({ gateway: null });
		expect(await scan("<!doctype html><p>clean</p>")).toEqual({
			allowed: true,
			reason: null,
		});
	});
});
