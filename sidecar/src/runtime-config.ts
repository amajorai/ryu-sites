import { z } from "zod";
import { edgeConfigSchema } from "./edge-readiness.ts";
import { approvedConnection } from "./extensions.ts";

/** Operator-owned, non-secret deployment wiring. Never part of a site artifact. */
export const runtimeConfigSchema = z
	.object({
		schemaVersion: z.literal(1).default(1),
		publicEnabled: z.boolean().default(false),
		baseDomain: z
			.string()
			.max(253)
			.regex(/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/)
			.default("localhost"),
		visitorPort: z.number().int().min(1).max(65_535).optional(),
		/** Proxy addresses or CIDRs allowed to report the visitor address. */
		trustedProxies: z.array(z.string().min(1).max(64)).max(32).default([]),
		ownerId: z.string().min(1).max(200).optional(),
		/**
		 * Optional edge/TLS readiness probe for custom domains. Without it, a
		 * verified custom domain stays pending TLS and serves no traffic.
		 */
		edge: edgeConfigSchema.optional(),
		identity: z
			.object({
				issuer: z.url().startsWith("https://"),
				clientId: z.string().min(1).max(200),
				toolAudience: z.url().startsWith("https://").optional(),
			})
			.strict()
			.optional(),
		spaceBindings: z
			.record(z.string().max(100), z.array(z.string().max(100)).max(30))
			.default({}),
		connectionBindings: z
			.record(
				z.string().max(100),
				z
					.array(approvedConnection)
					.max(20)
					.refine(
						(entries) =>
							new Set(entries.map((entry) => entry.id)).size === entries.length,
						"Connection IDs must be unique"
					)
			)
			.default({}),
		/**
		 * Lets Site owners and editors bind their visitors' own connectors from
		 * the Companion. `false` refuses and hides every owner binding.
		 */
		ownerConnections: z.boolean().default(true),
		/**
		 * Optional allowlist for owner bindings: exact Core tool IDs, or a
		 * prefix ending in `*` (for example `slack.*`). Bindings outside it are
		 * refused when saved and hidden from visitors afterwards.
		 */
		ownerConnectionTools: z
			.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}\*?$/))
			.max(200)
			.optional(),
		/**
		 * Core agents owner bindings may run as: exact IDs or a prefix ending in
		 * `*`. Bindings naming another agent are refused and hidden.
		 */
		ownerConnectionAgents: z
			.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\*?$/))
			.max(50)
			.default(["ryu"]),
		/**
		 * Tools the operator confirms are read-only. An owner binding may ask
		 * for read access only for these; every other owner binding is treated
		 * as read and write, so visitors confirm each call.
		 */
		ownerConnectionReadOnlyTools: z
			.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}\*?$/))
			.max(200)
			.default([]),
	})
	.strict();

export async function loadRuntimeConfig(path: string) {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return runtimeConfigSchema.parse({});
	}
	if (file.size > 64_000) {
		throw new Error("Sites runtime configuration exceeds 64 KB");
	}
	try {
		return runtimeConfigSchema.parse(await file.json());
	} catch {
		throw new Error("Sites runtime configuration is invalid; startup refused");
	}
}
