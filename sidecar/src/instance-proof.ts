/**
 * Lets the `ryu-sites mcp` lane prove that a loopback port belongs to the
 * running Sites sidecar before it sends the per-plugin Core bearer there.
 *
 * At startup the sidecar picks a random per-process secret and records
 * `{port, secret}` in the owner-only `management-endpoint.json`. Its
 * management API answers `GET /api/sites/instance-proof?challenge=…` without
 * authentication by returning HMAC-SHA256(secret, challenge). The MCP lane
 * sends a fresh challenge and only sends the bearer when the proof matches,
 * so a process that took over a stale port never receives the token. The
 * secret itself never leaves the data folder.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const INSTANCE_PROOF_PATH = "/api/sites/instance-proof";
const HEX_64 = /^[0-9a-f]{64}$/;
export const instanceSecretSchema = z.string().regex(HEX_64);
export const instanceChallengeSchema = z.string().regex(HEX_64);
export const instanceProofSchema = z.object({
	proof: z.string().regex(HEX_64),
});

/** A fresh 256-bit hex value for a process secret or a challenge. */
export function randomInstanceValue(): string {
	return randomBytes(32).toString("hex");
}

export function instanceProof(secret: string, challenge: string): string {
	return createHmac("sha256", secret)
		.update(`ryu-sites-instance:${challenge}`)
		.digest("hex");
}

export function instanceProofMatches(
	secret: string,
	challenge: string,
	proof: string
): boolean {
	const expected = Buffer.from(instanceProof(secret, challenge), "hex");
	const received = Buffer.from(proof, "hex");
	return (
		received.length === expected.length && timingSafeEqual(received, expected)
	);
}
