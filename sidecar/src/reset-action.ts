import type { ResetProvider } from "./contracts.ts";

const PROVIDER_LABELS: Record<ResetProvider, string> = {
	claude: "Claude Code",
	codex: "Codex",
	copilot: "GitHub Copilot",
};

/** The fixed, owner-triggered task sent through Ryu's existing agent bridge. */
export function resetActionTask(provider: ResetProvider): string {
	const label = PROVIDER_LABELS[provider];
	return [
		`The Site owner explicitly pressed “Use reset” for ${label}. Run one bounded reset check for provider id “${provider}”.`,
		"First inspect the user's current, connected account usage and its provider-reported resetAt value. A public forecast, an old announcement, or a passed timestamp is not account evidence.",
		"If the account reports a future automatic reset, stop without spending anything and return a concise scheduled result with the exact reset time, account/provider evidence, and the source of that value.",
		"If no future automatic reset is reported, inspect the installed provider/reset-watch plugin and its documented account action. Continue only when the account reports an available unexpired banked or on-demand reset, the user has separately enabled redeemAuthorized, and the action supports an idempotency key. Execute at most one reset and verify refreshed usage afterward.",
		"For Claude Code, Copilot, or any provider without a real documented redemption action, report unavailable instead of guessing an endpoint or simulating success. Never buy credits, change a plan, access another person's account, post to a third party, or modify workspace files.",
		"Return: status (scheduled, redeemed, or blocked), provider, observed reset time or null, evidence source, and the next safe action. Keep credentials and tokens out of the response.",
	].join("\n\n");
}
