import { managedSiteHostname, managedSiteOrigin } from "./site-state.ts";
import type {
	PublicEdgeConnector,
	PublicEdgeRoute,
	SiteDeployment,
	SiteDomain,
	SiteProject,
	SiteQuota,
} from "./types.ts";

const PROJECT_ID = "site_northstar_docs";
const DEPLOYMENT_ID = "deployment_northstar_v7";
const MANAGED_CONNECTOR_ID = "connector_managed_studio";
const BYO_CONNECTOR_ID = "connector_byo_frp";

export const DEMO_PROJECT: SiteProject = {
	createdAt: "2026-08-21T09:00:00.000Z",
	currentDeploymentId: DEPLOYMENT_ID,
	id: PROJECT_ID,
	name: "Northstar docs",
	ownerId: "demo-owner",
	slug: "northstar-docs",
	sourceKind: "local-project",
	status: "published",
	updatedAt: "2026-08-24T08:24:00.000Z",
};

export const DEMO_DEPLOYMENTS: SiteDeployment[] = [
	{
		buildId: "build_northstar_v7",
		createdAt: "2026-08-24T08:12:00.000Z",
		deploymentId: DEPLOYMENT_ID,
		entrypoint: "dist/index.html",
		projectId: PROJECT_ID,
		status: "ready",
		version: 7,
	},
	{
		buildId: "build_northstar_v6",
		createdAt: "2026-08-23T15:40:00.000Z",
		deploymentId: "deployment_northstar_v6",
		entrypoint: "dist/index.html",
		projectId: PROJECT_ID,
		status: "unpublished",
		version: 6,
	},
];

export const DEMO_DOMAINS: SiteDomain[] = [
	{
		createdAt: "2026-08-23T10:00:00.000Z",
		domain: "docs.northstar.example",
		lastCheckedAt: "2026-08-24T08:20:00.000Z",
		projectId: PROJECT_ID,
		status: "pending_tls",
		verification: [
			{
				expectedName: "docs.northstar.example",
				expectedValue: "site_northstar_docs.custom.sites.ryu.app",
				kind: "cname",
			},
		],
	},
	{
		createdAt: "2026-08-22T11:30:00.000Z",
		domain: "preview.northstar.example",
		lastCheckedAt: null,
		projectId: PROJECT_ID,
		status: "pending_dns",
		verification: [
			{
				expectedName: "_ryu.preview.northstar.example",
				expectedValue: "verify-site_northstar_docs",
				kind: "txt",
			},
		],
	},
];

export const DEMO_CONNECTORS: PublicEdgeConnector[] = [
	{
		capabilities: ["wildcard TLS", "route leases", "managed egress"],
		connectorId: MANAGED_CONNECTOR_ID,
		lastHeartbeatAt: "2026-08-24T08:24:00.000Z",
		nodeId: "node-studio",
		routeCount: 2,
		status: "connected",
		transport: "ryu-relay",
	},
	{
		capabilities: ["HTTP forwarding", "operator-owned relay"],
		connectorId: BYO_CONNECTOR_ID,
		lastHeartbeatAt: "2026-08-24T08:17:00.000Z",
		nodeId: "node-lab",
		routeCount: 1,
		status: "degraded",
		transport: "frp",
	},
];

export const DEMO_ROUTES: PublicEdgeRoute[] = [
	{
		connectorId: MANAGED_CONNECTOR_ID,
		createdAt: "2026-08-24T08:12:00.000Z",
		deploymentId: DEPLOYMENT_ID,
		host: managedSiteHostname(DEMO_PROJECT.slug),
		pathPrefix: "/",
		routeId: "route_northstar_site",
		status: "active",
		target: "site",
		updatedAt: "2026-08-24T08:12:00.000Z",
	},
	{
		connectorId: MANAGED_CONNECTOR_ID,
		createdAt: "2026-08-24T08:12:00.000Z",
		deploymentId: DEPLOYMENT_ID,
		host: managedSiteHostname(DEMO_PROJECT.slug),
		pathPrefix: "/widget.js",
		routeId: "route_northstar_widget",
		status: "active",
		target: "help-center-widget",
		updatedAt: "2026-08-24T08:12:00.000Z",
	},
	{
		connectorId: BYO_CONNECTOR_ID,
		createdAt: "2026-08-24T08:16:00.000Z",
		deploymentId: DEPLOYMENT_ID,
		host: "docs.northstar.example",
		pathPrefix: "/api/help-center",
		routeId: "route_northstar_help_api",
		status: "draining",
		target: "help-center-api",
		updatedAt: "2026-08-24T08:18:00.000Z",
	},
];

export const DEMO_QUOTAS: SiteQuota[] = [
	{
		detail: "Published projects on this plan",
		id: "published-sites",
		label: "Published Sites",
		limit: 10,
		unit: "sites",
		used: 2,
	},
	{
		detail: "One outbound connection per node, many route leases",
		id: "connectors",
		label: "Connectors",
		limit: 3,
		unit: "nodes",
		used: 1,
	},
	{
		detail: "Monthly managed build budget",
		id: "build-minutes",
		label: "Build minutes",
		limit: 60,
		unit: "min",
		used: 32,
	},
	{
		detail: "Source snapshots and deployment artifacts",
		id: "storage",
		label: "Storage",
		limit: 5,
		unit: "GB",
		used: 1.8,
	},
	{
		detail: "Managed edge egress this cycle",
		id: "bandwidth",
		label: "Bandwidth",
		limit: 25,
		unit: "GB",
		used: 21.4,
	},
	{
		detail: "Managed visitor allowance this cycle",
		id: "visitors",
		label: "Visitors",
		limit: 10_000,
		unit: "visitors",
		used: 1280,
	},
	{
		detail: "Custom-domain bindings on this plan",
		id: "custom-domains",
		label: "Custom domains",
		limit: 3,
		unit: "domains",
		used: 1,
	},
];

export const DEMO_MANAGED_ORIGIN = managedSiteOrigin(DEMO_PROJECT.slug);
