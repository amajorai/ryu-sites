import { z } from "zod";

export const siteSlug = z
	.string()
	.min(5)
	.max(48)
	.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const resourceName = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
export const siteSettings = z
	.object({
		mode: z.enum(["local", "connected"]).default("local"),
		audience: z
			.enum(["private", "invited", "workspace", "public"])
			.default("private"),
		workspaceId: z.string().max(100).nullable().default(null),
		viewers: z.array(z.string().email()).max(100).default([]),
		editors: z.array(z.string().email()).max(30).default([]),
		optionalSignIn: z.boolean().default(false),
		ai: z.boolean().default(false),
		aiDailyLimit: z.number().int().min(1).max(1000).default(100),
		storage: z.boolean().default(false),
		uploads: z.boolean().default(false),
		spaceId: z.string().max(100).nullable().default(null),
	})
	.strict();
export const createSiteInput = z
	.object({
		name: z.string().trim().min(1).max(100),
		slug: siteSlug,
		prompt: z.string().max(12_000).default(""),
		template: z
			.enum(["website", "help-center", "dashboard", "game"])
			.default("website"),
	})
	.strict();
export const saveVersionInput = z
	.object({
		html: z.string().min(1).max(2_000_000),
		message: z.string().max(500).default("Saved version"),
		commit: z
			.string()
			.regex(/^[a-f0-9]{40}$/)
			.nullable()
			.default(null),
		expectedRevision: z.number().int().nonnegative(),
	})
	.strict();
export const settingsInput = z
	.object({
		settings: siteSettings,
		expectedRevision: z.number().int().nonnegative(),
	})
	.strict();
export type SiteSettings = z.infer<typeof siteSettings>;
export interface SiteVersion {
	bytes: number;
	commit: string | null;
	createdAt: string;
	id: string;
	message: string;
}
export interface SiteDomainBinding {
	checkedAt: string | null;
	host: string;
	status: "pending_dns" | "pending_tls" | "active" | "failed";
	verification: string;
}
export interface RuntimeSite {
	aliases: string[];
	createdAt: string;
	deploymentId: string | null;
	domains: SiteDomainBinding[];
	hasPublished: boolean;
	id: string;
	name: string;
	ownerId: string;
	prompt: string;
	revision: number;
	schemaVersion: 1;
	settings: SiteSettings;
	slug: string;
	template: z.infer<typeof createSiteInput>["template"];
	updatedAt: string;
	versions: SiteVersion[];
}
export interface SitePrincipal {
	email: string;
	id: string;
	workspaceIds: string[];
}
export function isOwner(
	site: RuntimeSite,
	user: SitePrincipal | null
): boolean {
	return user?.id === site.ownerId;
}
export function canEdit(
	site: RuntimeSite,
	user: SitePrincipal | null
): boolean {
	return (
		isOwner(site, user) ||
		Boolean(
			user &&
				site.settings.workspaceId &&
				user.workspaceIds.includes(site.settings.workspaceId) &&
				site.settings.editors.includes(user.email.toLowerCase())
		)
	);
}
export function canVisit(
	site: RuntimeSite,
	user: SitePrincipal | null
): boolean {
	if (site.settings.audience === "public" || canEdit(site, user)) {
		return true;
	}
	if (!user) {
		return false;
	}
	if (site.settings.audience === "invited") {
		return site.settings.viewers.includes(user.email.toLowerCase());
	}
	return (
		site.settings.audience === "workspace" &&
		Boolean(
			site.settings.workspaceId &&
				user.workspaceIds.includes(site.settings.workspaceId)
		)
	);
}
export const SITE_LIMITS = {
	projects: 30,
	versions: 100,
	totalArtifactBytes: 50_000_000,
	recordBytes: 64_000,
	records: 1000,
	fileBytes: 5_000_000,
	files: 100,
} as const;
