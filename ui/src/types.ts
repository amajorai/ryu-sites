export type SiteProjectSource = "prompt" | "local-project" | "help-center";
export type SiteProjectStatus = "draft" | "published" | "suspended";

export interface SiteProject {
	createdAt: string;
	currentDeploymentId: string | null;
	id: string;
	name: string;
	ownerId: string;
	slug: string;
	sourceKind: SiteProjectSource;
	status: SiteProjectStatus;
	updatedAt: string;
}

export type SiteDeploymentStatus =
	| "building"
	| "ready"
	| "failed"
	| "unpublished";

export interface SiteDeployment {
	buildId: string;
	createdAt: string;
	deploymentId: string;
	entrypoint: string;
	projectId: string;
	status: SiteDeploymentStatus;
	version: number;
}

export type SiteDomainStatus =
	| "pending_dns"
	| "pending_tls"
	| "active"
	| "failed"
	| "revoked";

export interface SiteDomain {
	createdAt: string;
	domain: string;
	lastCheckedAt: string | null;
	projectId: string;
	status: SiteDomainStatus;
	verification: {
		expectedName: string;
		expectedValue: string;
		kind: "cname" | "txt";
	}[];
}

export type PublicEdgeTransport =
	| "ryu-relay"
	| "frp"
	| "cloudflared"
	| "rathole";
export type PublicEdgeConnectorStatus =
	| "provisioning"
	| "connected"
	| "degraded"
	| "revoked";

export interface PublicEdgeConnector {
	capabilities: string[];
	connectorId: string;
	lastHeartbeatAt: string | null;
	nodeId: string;
	routeCount: number;
	status: PublicEdgeConnectorStatus;
	transport: PublicEdgeTransport;
}

export type PublicEdgeRouteStatus =
	| "pending"
	| "active"
	| "draining"
	| "revoked";
export type PublicEdgeRouteTarget =
	| "site"
	| "help-center-widget"
	| "help-center-api";

export interface PublicEdgeRoute {
	connectorId: string;
	createdAt: string;
	deploymentId: string;
	host: string;
	pathPrefix: string;
	routeId: string;
	status: PublicEdgeRouteStatus;
	target: PublicEdgeRouteTarget;
	updatedAt: string;
}

export type SiteQuotaId =
	| "build-minutes"
	| "storage"
	| "bandwidth"
	| "published-sites"
	| "connectors"
	| "visitors"
	| "custom-domains";

export interface SiteQuota {
	detail: string;
	id: SiteQuotaId;
	label: string;
	limit: number;
	unit: string;
	used: number;
}
