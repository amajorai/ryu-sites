import { z } from "zod";
import {
	createSiteInput,
	type RuntimeSite,
	siteSettings,
} from "./contracts.ts";
import { siteTool } from "./extensions.ts";

export const siteExtensionsRecordSchema = z.object({
	mcp: z.boolean(),
	ui: z.boolean(),
	tools: z.array(
		siteTool.extend({ collection: siteTool.shape.collection.removeDefault() })
	),
	connections: z.array(z.string()),
});
export const siteSettingsRecordSchema = z.object({
	mode: z.enum(["local", "connected"]),
	audience: z.enum(["private", "invited", "workspace", "public"]),
	workspaceId: z.string().nullable(),
	viewers: z.array(z.string()),
	editors: z.array(z.string()),
	optionalSignIn: z.boolean(),
	agentActions: z.boolean(),
	ai: z.boolean(),
	aiDailyLimit: z.number(),
	aiMode: z.enum(["grounded", "general"]),
	aiAnonymous: z.boolean(),
	aiSystemPrompt: z.string(),
	storage: z.boolean(),
	uploads: z.boolean(),
	spaceId: z.string().nullable(),
	database: z
		.object({ databaseId: z.string(), spaceId: z.string() })
		.nullable(),
	sharedData: z.object({
		enabled: z.boolean(),
		write: z.enum(["signed-in", "editors"]),
	}),
	extensions: siteExtensionsRecordSchema,
	allowRemix: z.boolean(),
});
const version = z.object({
	bytes: z.number(),
	commit: z.string().nullable(),
	createdAt: z.string(),
	extensions: siteExtensionsRecordSchema.optional(),
	id: z.string(),
	message: z.string(),
});
const domain = z.object({
	checkedAt: z.string().nullable(),
	host: z.string(),
	status: z.enum(["pending_dns", "pending_tls", "active", "failed"]),
	verification: z.string(),
});
export const ownerConnectionRecordSchema = z.object({
	agentId: z.string(),
	description: z.string(),
	id: z.string(),
	label: z.string(),
	readOnly: z.boolean(),
	revision: z.number(),
	toolId: z.string(),
	updatedAt: z.string(),
	updatedBy: z.string(),
});
const site = z.object({
	access: z.enum(["owner", "editor", "viewer"]).optional(),
	aliases: z.array(z.string()),
	connections: z.array(ownerConnectionRecordSchema).optional(),
	createdAt: z.string(),
	deploymentId: z.string().nullable(),
	domains: z.array(domain),
	hasPublished: z.boolean(),
	id: z.string(),
	name: z.string(),
	ownerId: z.string(),
	prompt: z.string(),
	remixedFrom: z
		.object({ name: z.string(), siteId: z.string(), versionId: z.string() })
		.nullable()
		.optional(),
	revision: z.number(),
	schemaVersion: z.literal(1),
	settings: siteSettings,
	slug: z.string(),
	template: createSiteInput.shape.template.removeDefault(),
	updatedAt: z.string(),
	versions: z.array(version),
});
/** Validate the complete publisher while retaining its object and nested records. */
export const runtimeSiteSchema: z.ZodType<RuntimeSite> = z.custom<RuntimeSite>(
	(cause) =>
		site.extend({ settings: siteSettingsRecordSchema }).safeParse(cause).success
);
export const runtimeSitesSchema: z.ZodType<RuntimeSite[]> = z.custom<
	RuntimeSite[]
>((cause) => z.array(runtimeSiteSchema).safeParse(cause).success);
export const storedSiteSchema = z.custom<
	Omit<RuntimeSite, "settings"> & { settings: z.input<typeof siteSettings> }
>((cause) => site.safeParse(cause).success);
export function readStoredSite(serialized: string): RuntimeSite {
	const stored = storedSiteSchema.parse(JSON.parse(serialized));
	// Sites saved before owner-managed connections hold none.
	return {
		...stored,
		connections: stored.connections ?? [],
		settings: siteSettings.parse(stored.settings),
	};
}
export const stateRowSchema = z.object({ state: z.string() });
export const artifactRowSchema = z.object({ html: z.string() });
export const legacyRecordsSchema = z.array(
	z.object({
		owner: z.string(),
		collection: z.string(),
		key: z.string(),
		value: z.string(),
	})
);
