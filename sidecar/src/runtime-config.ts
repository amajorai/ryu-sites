import { z } from "zod";

/** Operator-owned, non-secret deployment wiring. Never part of a site artifact. */
export const runtimeConfigSchema = z.object({
	schemaVersion: z.literal(1).default(1),
	publicEnabled: z.boolean().default(false),
	baseDomain: z.string().max(253).regex(/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/).default("localhost"),
	visitorPort: z.number().int().min(1).max(65535).optional(),
	ownerId: z.string().min(1).max(200).optional(),
	identity: z.object({ issuer: z.url().startsWith("https://"), clientId: z.string().min(1).max(200) }).strict().optional(),
	spaceBindings: z.record(z.string().max(100), z.array(z.string().max(100)).max(30)).default({}),
}).strict();

export async function loadRuntimeConfig(path: string) {
	const file = Bun.file(path);
	if (!await file.exists()) return runtimeConfigSchema.parse({});
	if (file.size > 64_000) throw new Error("Sites runtime configuration exceeds 64 KB");
	try { return runtimeConfigSchema.parse(await file.json()); }
	catch { throw new Error("Sites runtime configuration is invalid; startup refused"); }
}
