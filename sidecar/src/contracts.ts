import { z } from "zod";
import type { SiteExtensions } from "./extensions.ts";
import { siteExtensions } from "./extensions.ts";

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
export const resetProvider = z.enum(["codex", "claude", "copilot"]);
export type ResetProvider = z.infer<typeof resetProvider>;
export const siteDatabaseBinding = z
	.object({
		databaseId: z.string().min(1).max(100),
		spaceId: z.string().min(1).max(100),
	})
	.strict();
export type SiteDatabaseBinding = z.infer<typeof siteDatabaseBinding>;
export interface ResetActionResult {
	detail: string;
	provider: ResetProvider;
	status: "completed";
}
/**
 * Owner opt-in for data every permitted visitor of a Site reads together.
 * Readers are everyone allowed to visit; `write` names who may add records.
 */
export const siteSharedData = z
	.object({
		enabled: z.boolean().default(false),
		write: z.enum(["signed-in", "editors"]).default("signed-in"),
	})
	.strict();
export type SiteSharedData = z.infer<typeof siteSharedData>;
/**
 * The reserved record owner under which shared records are stored beside
 * per-visitor records. Each shared record names its real author inside its
 * stored envelope; a visitor whose account ID equals this value is refused.
 */
export const SHARED_RECORDS_OWNER = "ryu-sites:shared";
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
		agentActions: z.boolean().default(false),
		ai: z.boolean().default(false),
		aiDailyLimit: z.number().int().min(1).max(1000).default(100),
		/**
		 * `grounded` answers only from the bound Space (`/_ryu/ask`); `general`
		 * also lets the page call the model for its own tasks (`/_ryu/complete`).
		 */
		aiMode: z.enum(["grounded", "general"]).default("grounded"),
		/** General AI calls without visitor sign-in. Off unless the owner opts in. */
		aiAnonymous: z.boolean().default(false),
		/** Owner instructions that always precede a page's own system text. */
		aiSystemPrompt: z.string().max(4000).default(""),
		storage: z.boolean().default(false),
		uploads: z.boolean().default(false),
		spaceId: z.string().max(100).nullable().default(null),
		database: siteDatabaseBinding.nullable().default(null),
		sharedData: siteSharedData.default({
			enabled: false,
			write: "signed-in",
		}),
		extensions: siteExtensions,
		/**
		 * Owner opt-in that lets anyone who may visit start their own private
		 * copy from the deployed version. Off by default.
		 */
		allowRemix: z.boolean().default(false),
	})
	.strict();
export const createSiteInput = z
	.object({
		name: z.string().trim().min(1).max(100),
		slug: siteSlug,
		prompt: z.string().max(12_000).default(""),
		template: z
			.enum(["website", "help-center", "dashboard", "game", "reset-calendar"])
			.default("website"),
	})
	.strict();
/**
 * Starts a new private Site from another one. `expectedRevision`, when sent,
 * pins the source revision the caller reviewed.
 */
export const remixSiteInput = z
	.object({
		name: z.string().trim().min(1).max(100),
		slug: siteSlug,
		expectedRevision: z.number().int().nonnegative().optional(),
	})
	.strict();
/** Where a remixed or duplicated Site came from. */
export interface SiteProvenance {
	/** The source Site's name when the copy was made. */
	name: string;
	siteId: string;
	versionId: string;
}
/**
 * The only settings a remix carries over. Access lists, workspace, sign-in,
 * AI instructions, Space, database, shared data, extensions and the remix
 * opt-in itself always start at their private defaults.
 */
export function remixSettings(source: SiteSettings): SiteSettings {
	return siteSettings.parse({
		mode: source.mode,
		aiMode: source.aiMode,
		aiDailyLimit: source.aiDailyLimit,
	});
}
/**
 * One gallery entry for a Site another person allows remixing. It names the
 * Site and its deployed version only; settings, access lists, domains and
 * connections stay with the full Site record.
 */
export const remixableSite = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	template: createSiteInput.shape.template.removeDefault(),
	deploymentId: z.string(),
	updatedAt: z.string(),
	access: z.enum(["editor", "viewer"]),
});
export type RemixableSite = z.infer<typeof remixableSite>;
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
/** Owner-managed connector bindings one Site may hold. */
export const OWNER_CONNECTION_LIMIT = 20;
/** Visitor-facing ID prefix that keeps owner bindings apart from operator ones. */
export const OWNER_CONNECTION_PREFIX = "owner.";
/** A Core tool ID: printable, no whitespace, never a URL or credential field. */
export const connectionToolId = z
	.string()
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}$/);
export const connectionAgentId = z
	.string()
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
/**
 * One owner or editor declared connector binding. The visitor's own identity
 * runs the tool; the binding names only which tool and how much access.
 */
export const ownerConnectionInput = z
	.object({
		id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
		label: z.string().trim().min(1).max(100),
		description: z.string().trim().max(300).default(""),
		toolId: connectionToolId,
		agentId: connectionAgentId.default("ryu"),
		readOnly: z.boolean(),
		/** Asks every visitor to review this binding again without other changes. */
		reconsent: z.boolean().default(false),
	})
	.strict();
export const ownerConnectionsInput = z
	.object({
		connections: z
			.array(ownerConnectionInput)
			.max(OWNER_CONNECTION_LIMIT)
			.refine(
				(entries) =>
					new Set(entries.map((entry) => entry.id)).size === entries.length,
				"Connection IDs must be unique"
			),
		expectedRevision: z.number().int().nonnegative(),
	})
	.strict();
export interface OwnerConnection {
	agentId: string;
	description: string;
	id: string;
	label: string;
	readOnly: boolean;
	/** Bumped on every material change; a new revision invalidates consents. */
	revision: number;
	toolId: string;
	updatedAt: string;
	updatedBy: string;
}
export interface SiteVersion {
	bytes: number;
	commit: string | null;
	createdAt: string;
	extensions?: SiteExtensions;
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
	access?: "owner" | "editor" | "viewer";
	aliases: string[];
	/** Owner-managed connector bindings; absent on Sites saved before them. */
	connections?: OwnerConnection[];
	createdAt: string;
	deploymentId: string | null;
	domains: SiteDomainBinding[];
	hasPublished: boolean;
	id: string;
	name: string;
	ownerId: string;
	prompt: string;
	/** Set on a Site started by remixing or duplicating another one. */
	remixedFrom?: SiteProvenance | null;
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
	databaseBytes: 1_200_000,
	recordBytes: 64_000,
	records: 1000,
	fileBytes: 5_000_000,
	files: 100,
	// Per-visitor shares keep one visitor from exhausting a Site-wide budget.
	recordsPerVisitor: 100,
	recordBytesPerVisitor: 120_000,
	filesPerVisitor: 10,
	fileBytesPerVisitor: 25_000_000,
	answerSharePercent: 20,
	ownerConnections: OWNER_CONNECTION_LIMIT,
	// Connected tool calls one signed-in visitor may make per Site per UTC day.
	connectionCallsPerVisitor: 200,
	// Shared multi-visitor records. They also count toward databaseBytes.
	sharedRecords: 1000,
	sharedRecordBytes: 16_000,
	// Each author's share of shared records, like the per-visitor share above.
	sharedRecordsPerAuthor: 100,
	sharedBytesPerAuthor: 120_000,
	sharedWritesPerVisitorPerMinute: 30,
	sharedWritesPerSitePerMinute: 600,
	sharedStreamsPerSite: 100,
	sharedStreamsPerVisitor: 4,
	// Remixes and duplicates one person may start per UTC day.
	remixesPerDay: 20,
} as const;
/** Bounds on one general in-page AI call (`/_ryu/complete`). */
export const SITE_AI_LIMITS = {
	/** Characters of prompt, or of all chat messages together. */
	promptChars: 8000,
	/** Characters of the page's own system text. */
	systemChars: 2000,
	chatMessages: 20,
	defaultMaxTokens: 512,
	maxTokens: 2000,
	/** Output characters allowed per requested token. */
	charsPerToken: 4,
} as const;
const aiMessage = z
	.object({
		role: z.enum(["user", "assistant"]),
		content: z.string().trim().min(1).max(SITE_AI_LIMITS.promptChars),
	})
	.strict();
/**
 * One general in-page AI call: a single `prompt` or a `messages` chat,
 * never both. `maxTokens` is clamped, not refused, so pages stay portable.
 */
export const siteCompletionInput = z
	.object({
		prompt: z.string().trim().min(1).max(SITE_AI_LIMITS.promptChars).optional(),
		messages: z
			.array(aiMessage)
			.min(1)
			.max(SITE_AI_LIMITS.chatMessages)
			.refine(
				(messages) => messages.at(-1)?.role === "user",
				"The last chat message must come from the user"
			)
			.refine(
				(messages) =>
					messages.reduce((total, item) => total + item.content.length, 0) <=
					SITE_AI_LIMITS.promptChars,
				`Chat messages exceed ${SITE_AI_LIMITS.promptChars} characters`
			)
			.optional(),
		system: z.string().trim().max(SITE_AI_LIMITS.systemChars).default(""),
		maxTokens: z
			.number()
			.int()
			.optional()
			.transform((value) =>
				Math.min(
					SITE_AI_LIMITS.maxTokens,
					Math.max(1, value ?? SITE_AI_LIMITS.defaultMaxTokens)
				)
			),
	})
	.strict()
	.refine(
		(input) => (input.prompt === undefined) !== (input.messages === undefined),
		"Send either a prompt or chat messages"
	);
export type SiteCompletionInput = z.infer<typeof siteCompletionInput>;
/** Daily AI answers one visitor may use from a Site's daily limit. */
export function answersPerVisitor(dailyLimit: number): number {
	return Math.max(
		1,
		Math.floor((dailyLimit * SITE_LIMITS.answerSharePercent) / 100)
	);
}
/** Largest saved HTML version, in UTF-8 bytes. */
export const SITE_ARTIFACT_MAX_BYTES = 2_000_000;
/**
 * The saved-version rules every authoring path shares: a self-contained HTML
 * build that starts with a doctype and fits the size cap. Returns the refusal,
 * or null when the HTML may be saved.
 */
export function artifactProblem(
	html: string
): { code: string; message: string; status: number } | null {
	if (new TextEncoder().encode(html).length > SITE_ARTIFACT_MAX_BYTES) {
		return { code: "quota", message: "Artifact exceeds 2 MB", status: 413 };
	}
	if (!/^\s*<!doctype html/i.test(html)) {
		return {
			code: "incompatible",
			message:
				"Import a self-contained HTML build beginning with <!doctype html>",
			status: 400,
		};
	}
	return null;
}
/** The visitor origin of a Site slug, without a trailing slash. */
export function siteOrigin(
	slug: string,
	baseDomain: string,
	visitorPort: number | undefined
): string {
	return baseDomain === "localhost"
		? `http://${slug}.localhost:${visitorPort}`
		: `https://${slug}.${baseDomain}`;
}
