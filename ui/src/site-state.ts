import type {
	PublicEdgeRoute,
	SiteDomain,
	SiteProject,
	SiteQuota,
} from "./types.ts";

export const MANAGED_SITE_DOMAIN = "sites.ryu.app";
export const WILDCARD_MANAGED_SITE_DOMAIN = `*.${MANAGED_SITE_DOMAIN}`;

export type SiteQuotaState = "healthy" | "attention" | "exhausted";
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface DomainStatusCopy {
	detail: string;
	label: string;
	tone: StatusTone;
}

function normalizeSiteSlug(input: string): string {
	return (
		input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "site"
	);
}

export function managedSiteHostname(slug: string): string {
	return `${normalizeSiteSlug(slug)}.${MANAGED_SITE_DOMAIN}`;
}

export function managedSiteOrigin(slug: string): string {
	return `https://${managedSiteHostname(slug)}`;
}

function normalizePathPrefix(pathPrefix: string): string {
	const trimmed = pathPrefix.trim();
	if (trimmed.length === 0 || trimmed === "/") {
		return "/";
	}
	return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export function routeDisplay(
	route: Pick<PublicEdgeRoute, "host" | "pathPrefix">
): string {
	return `${route.host}${normalizePathPrefix(route.pathPrefix)}`;
}

export function domainStatusCopy(
	status: SiteDomain["status"]
): DomainStatusCopy {
	const copy: Record<SiteDomain["status"], DomainStatusCopy> = {
		active: {
			detail: "DNS and certificate are both ready",
			label: "Live",
			tone: "success",
		},
		failed: {
			detail: "The last verification did not complete",
			label: "Needs attention",
			tone: "danger",
		},
		pending_dns: {
			detail: "Add the displayed record before TLS can begin",
			label: "DNS pending",
			tone: "warning",
		},
		pending_tls: {
			detail: "DNS is seen; certificate issuance is still pending",
			label: "TLS pending",
			tone: "info",
		},
		revoked: {
			detail: "This domain binding no longer routes traffic",
			label: "Revoked",
			tone: "neutral",
		},
	};
	return copy[status];
}

export function quotaState(used: number, limit: number): SiteQuotaState {
	if (limit <= 0 || used >= limit) {
		return "exhausted";
	}
	if (used / limit >= 0.8) {
		return "attention";
	}
	return "healthy";
}

export function quotaPercent(used: number, limit: number): number {
	if (limit <= 0) {
		return 100;
	}
	return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export function widgetScriptSnippet(
	project: Pick<SiteProject, "slug">,
	publicSiteKey: string
): string {
	const safePublicSiteKey = publicSiteKey.trim().replace(/[^a-zA-Z0-9_-]/g, "");
	return `<script async src="${managedSiteOrigin(project.slug)}/widget.js" data-site-key="${safePublicSiteKey}" data-theme="auto" data-position="right"></script>`;
}

export function quotaCardState(quota: SiteQuota): SiteQuotaState {
	return quotaState(quota.used, quota.limit);
}
