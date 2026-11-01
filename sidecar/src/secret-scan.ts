import { z } from "zod";
import type { SitesGatewayConfig } from "./standalone-config.ts";

export interface ArtifactScanResult {
	allowed: boolean;
	reason: string | null;
}

/**
 * Built-in credential patterns for standalone Sites, which has no Core bridge
 * to the Gateway scanner. The first ten mirror the Gateway's built-in `secret`
 * guardrail so a Site that deploys under Core also deploys standalone; the rest
 * cover common provider key formats. A match blocks deployment; it is not a
 * complete secret audit.
 */
const SECRET_PATTERNS: readonly (readonly [name: string, pattern: RegExp])[] = [
	["openai_key", /sk-[A-Za-z0-9]{20,}/],
	["anthropic_key", /sk-ant-[A-Za-z0-9\-_]{20,}/],
	["aws_access_key", /AKIA[0-9A-Z]{16}/],
	["aws_secret_key", /aws.{0,20}secret.{0,20}['"][0-9a-zA-Z/+]{40}['"]/i],
	["github_token_classic", /ghp_[A-Za-z0-9]{36}/],
	["github_token_fg", /github_pat_[A-Za-z0-9_]{82}/],
	["bearer_token", /bearer\s+[A-Za-z0-9\-._~+/]{40,}/i],
	[
		"pem_private_key",
		/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
	],
	[
		"generic_api_key",
		/(?:api_key|apikey|api-key)\s*[:=]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?/i,
	],
	[
		"db_connection",
		/(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^\s]+:[^\s]+@/i,
	],
	["github_token_other", /\bgh[ousr]_[A-Za-z0-9]{36,255}\b/],
	["stripe_secret_key", /\b[rs]k_live_[A-Za-z0-9]{20,}\b/],
	["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
	[
		"slack_webhook",
		/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/,
	],
	["google_api_key", /\bAIza[0-9A-Za-z\-_]{35}\b/],
	["gitlab_token", /\bglpat-[A-Za-z0-9\-_]{20,}\b/],
	["npm_token", /\bnpm_[A-Za-z0-9]{36}\b/],
	["sendgrid_key", /\bSG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}\b/],
];

/** Names of the built-in credential patterns, for documentation and tests. */
export const SECRET_PATTERN_NAMES = SECRET_PATTERNS.map(([name]) => name);

/** Scans text for known credential formats without leaving the process. */
export function scanForSecrets(text: string): ArtifactScanResult {
	for (const [name, pattern] of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			return { allowed: false, reason: `secret guardrail tripped (${name})` };
		}
	}
	return { allowed: true, reason: null };
}

const gatewayVerdict = z.object({
	allowed: z.boolean(),
	reason: z.string().nullable().optional(),
});

/**
 * Builds the standalone deploy scanner. The built-in patterns always run; a
 * configured Gateway must also allow the artifact. A Gateway that cannot be
 * reached, refuses the key or answers out of contract throws, so the deploy
 * stays blocked instead of falling back to the weaker local check alone.
 */
export function createStandaloneScanner(options: {
	gateway: SitesGatewayConfig | null;
	fetchImpl?: typeof fetch;
}): (html: string) => Promise<ArtifactScanResult> {
	const { gateway } = options;
	const doFetch = options.fetchImpl ?? fetch;
	return async (html) => {
		const local = scanForSecrets(html);
		if (!(local.allowed && gateway)) {
			return local;
		}
		const headers = new Headers({ "content-type": "application/json" });
		if (gateway.key) {
			headers.set("authorization", `Bearer ${gateway.key}`);
		}
		const response = await doFetch(`${gateway.url}/v1/firewall/check`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers,
			body: JSON.stringify({ text: html, checks: ["secret"] }),
		});
		if (!response.ok) {
			throw new Error(`Gateway secret scanner returned ${response.status}`);
		}
		const verdict = gatewayVerdict.parse(await response.json());
		return { allowed: verdict.allowed, reason: verdict.reason ?? null };
	};
}
