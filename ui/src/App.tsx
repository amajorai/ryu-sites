import {
	AlertCircleIcon,
	ArrowRight01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge, Button } from "@ryu/blocks/companion/controls";
import { useMemo, useState } from "react";
import {
	DEMO_CONNECTORS,
	DEMO_DEPLOYMENTS,
	DEMO_DOMAINS,
	DEMO_MANAGED_ORIGIN,
	DEMO_PROJECT,
	DEMO_QUOTAS,
	DEMO_ROUTES,
} from "./sample-data.ts";
import {
	domainStatusCopy,
	managedSiteOrigin,
	quotaCardState,
	quotaPercent,
	routeDisplay,
	type SiteQuotaState,
	widgetScriptSnippet,
} from "./site-state.ts";
import type {
	PublicEdgeConnector,
	PublicEdgeRoute,
	SiteDeployment,
	SiteDomain,
	SiteProject,
	SiteQuota,
} from "./types.ts";

type SitesView = "overview" | "projects" | "edge" | "widget";
type DeliveryMode = "preview" | "byo" | "managed";
type WidgetTab = "ask" | "help" | "contact";
type CopyStatus = "idle" | "copied" | "unavailable";

function contextView(): SitesView | null {
	const view =
		typeof window === "undefined" ? undefined : window.ryu?.context?.view;
	return view === "overview" ||
		view === "projects" ||
		view === "edge" ||
		view === "widget"
		? view
		: null;
}

const MODE_COPY: Record<
	DeliveryMode,
	{ detail: string; label: string; shortLabel: string }
> = {
	byo: {
		detail: "Operator-owned relay and DNS",
		label: "BYO relay",
		shortLabel: "BYO",
	},
	managed: {
		detail: "Ryu wildcard edge and managed TLS",
		label: "Managed Ryu edge",
		shortLabel: "Managed",
	},
	preview: {
		detail: "Local node only; no public route",
		label: "Local preview",
		shortLabel: "Preview",
	},
};

const TARGET_LABELS: Record<PublicEdgeRoute["target"], string> = {
	"help-center-api": "Help Center API",
	"help-center-widget": "Help Center widget",
	site: "Site assets",
};

const TRANSPORT_LABELS: Record<PublicEdgeConnector["transport"], string> = {
	cloudflared: "Cloudflare Tunnel",
	frp: "frp relay",
	rathole: "rathole",
	"ryu-relay": "RyuRelay",
};

const QUOTA_COPY: Record<SiteQuotaState, { className: string; label: string }> =
	{
		attention: {
			className: "border-warning/40 bg-warning/10 text-warning-foreground",
			label: "Near limit",
		},
		exhausted: {
			className: "border-destructive/40 bg-destructive/10 text-destructive",
			label: "At limit",
		},
		healthy: {
			className: "border-success/35 bg-success/10 text-success",
			label: "On track",
		},
	};

function StatusPill({
	label,
	tone = "neutral",
}: {
	label: string;
	tone?: "neutral" | "info" | "success" | "warning" | "danger";
}) {
	const toneClassName = {
		danger: "border-destructive/35 bg-destructive/10 text-destructive",
		info: "border-info/35 bg-info/10 text-info",
		neutral: "border-border bg-muted/55 text-muted-foreground",
		success: "border-success/35 bg-success/10 text-success",
		warning: "border-warning/35 bg-warning/10 text-warning-foreground",
	}[tone];

	return (
		<Badge
			className={`font-mono text-[10px] uppercase tracking-[0.12em] ${toneClassName}`}
			variant={
				tone === "danger"
					? "destructive"
					: tone === "success"
						? "secondary"
						: "outline"
			}
		>
			{label}
		</Badge>
	);
}

function SectionHeading({
	eyebrow,
	muted,
	title,
}: {
	eyebrow: string;
	muted?: string;
	title: string;
}) {
	return (
		<div className="flex flex-wrap items-end justify-between gap-3">
			<div>
				<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
					{eyebrow}
				</p>
				<h2 className="mt-1 font-medium text-xl tracking-tight">{title}</h2>
			</div>
			{muted ? <p className="text-muted-foreground text-xs">{muted}</p> : null}
		</div>
	);
}

function DeliveryModeSelector({
	mode,
	onChange,
}: {
	mode: DeliveryMode;
	onChange: (mode: DeliveryMode) => void;
}) {
	return (
		<div
			aria-label="Delivery mode"
			className="grid grid-cols-3 gap-1 rounded-2xl border border-border/70 bg-muted/60 p-1"
			role="tablist"
		>
			{(Object.keys(MODE_COPY) as DeliveryMode[]).map((option) => {
				const active = mode === option;
				return (
					<Button
						aria-selected={active}
						className="rounded-xl font-medium text-xs"
						key={option}
						onClick={() => onChange(option)}
						role="tab"
						size="sm"
						type="button"
						variant={active ? "secondary" : "ghost"}
					>
						{MODE_COPY[option].shortLabel}
					</Button>
				);
			})}
		</div>
	);
}

function QuotaCard({ quota }: { quota: SiteQuota }) {
	const state = quotaCardState(quota);
	const percent = quotaPercent(quota.used, quota.limit);
	const copy = QUOTA_COPY[state];

	return (
		<div
			className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
			data-testid="sites-quota-card"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
						{quota.label}
					</p>
					<p className="mt-2 font-medium text-2xl tracking-tight">
						{quota.used}
						<span className="font-normal text-muted-foreground text-xs">
							{" "}
							/ {quota.limit} {quota.unit}
						</span>
					</p>
				</div>
				<StatusPill
					label={copy.label}
					tone={
						state === "exhausted"
							? "danger"
							: state === "attention"
								? "warning"
								: "success"
					}
				/>
			</div>
			<div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					aria-label={`${percent}% used`}
					className={`h-full rounded-full transition-[width] ${state === "exhausted" ? "bg-destructive" : state === "attention" ? "bg-warning" : "bg-primary"}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<p className="mt-2 text-muted-foreground text-xs">{quota.detail}</p>
		</div>
	);
}

function ConnectorCard({ connector }: { connector: PublicEdgeConnector }) {
	const statusTone =
		connector.status === "connected"
			? "success"
			: connector.status === "degraded"
				? "warning"
				: "neutral";
	return (
		<div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-3">
					<span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
						<HugeiconsIcon aria-hidden="true" icon={Link01Icon} />
					</span>
					<div>
						<p className="font-medium text-sm">
							{TRANSPORT_LABELS[connector.transport]}
						</p>
						<p className="font-mono text-[10px] text-muted-foreground">
							{connector.nodeId}
						</p>
					</div>
				</div>
				<StatusPill label={connector.status} tone={statusTone} />
			</div>
			<div className="mt-4 grid grid-cols-2 gap-3 text-xs">
				<div className="rounded-xl bg-muted/55 p-3">
					<p className="text-muted-foreground">Route leases</p>
					<p className="mt-1 font-medium text-lg">{connector.routeCount}</p>
				</div>
				<div className="rounded-xl bg-muted/55 p-3">
					<p className="text-muted-foreground">Last heartbeat</p>
					<p className="mt-1 font-medium text-sm">
						{connector.lastHeartbeatAt ? "2 min ago" : "Not seen"}
					</p>
				</div>
			</div>
			<div className="mt-3 flex flex-wrap gap-1.5">
				{connector.capabilities.map((capability) => (
					<span
						className="rounded-full border border-border/70 px-2 py-1 text-[10px] text-muted-foreground"
						key={capability}
					>
						{capability}
					</span>
				))}
			</div>
		</div>
	);
}

function DomainRow({ domain }: { domain: SiteDomain }) {
	const status = domainStatusCopy(domain.status);
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-border/60 border-b py-3 first:pt-0 last:border-0 last:pb-0">
			<div className="min-w-0">
				<p className="truncate font-medium text-sm">{domain.domain}</p>
				<p className="mt-1 text-muted-foreground text-xs">{status.detail}</p>
			</div>
			<StatusPill label={status.label} tone={status.tone} />
		</div>
	);
}

function RouteRow({ route }: { route: PublicEdgeRoute }) {
	return (
		<div className="grid gap-2 border-border/60 border-b py-3 first:pt-0 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1.4fr)_0.8fr_auto] sm:items-center">
			<div className="min-w-0">
				<p className="truncate font-mono text-xs">{routeDisplay(route)}</p>
				<p className="mt-1 text-muted-foreground text-xs">
					{TARGET_LABELS[route.target]}
				</p>
			</div>
			<p className="font-mono text-[10px] text-muted-foreground">
				{route.routeId}
			</p>
			<StatusPill
				label={route.status}
				tone={
					route.status === "active"
						? "success"
						: route.status === "draining"
							? "warning"
							: "neutral"
				}
			/>
		</div>
	);
}

function ProjectStatusCard({ project }: { project: SiteProject }) {
	return (
		<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
			<div className="flex flex-wrap items-start justify-between gap-3 border-border/70 border-b pb-4">
				<div className="min-w-0">
					<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
						Current project
					</p>
					<h2 className="mt-2 truncate font-medium text-xl tracking-tight">
						{project.name}
					</h2>
				</div>
				<StatusPill label="Published preview" tone="info" />
			</div>
			<div className="mt-4 grid gap-3 sm:grid-cols-2">
				<div className="rounded-xl bg-muted/55 p-3">
					<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
						Managed origin
					</p>
					<p className="mt-2 flex items-center gap-2 break-all font-mono text-xs">
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0"
							icon={Link01Icon}
						/>
						{managedSiteOrigin(project.slug)}
					</p>
				</div>
				<div className="rounded-xl bg-muted/55 p-3">
					<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
						Source
					</p>
					<p className="mt-2 font-medium text-sm">
						{project.sourceKind.replace("-", " ")}
					</p>
				</div>
			</div>
		</section>
	);
}

function OverviewView({
	mode,
	onModeChange,
}: {
	mode: DeliveryMode;
	onModeChange: (mode: DeliveryMode) => void;
}) {
	const modeCopy = MODE_COPY[mode];
	return (
		<div className="mx-auto w-full max-w-[1320px] space-y-7 px-5 py-7 sm:px-8">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
						Overview
					</p>
					<h1 className="mt-2 font-medium text-3xl tracking-[-0.04em]">
						Site status
					</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-relaxed">
						Routes, delivery mode, domains, and quota for the current project.
					</p>
				</div>
				<div className="flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-2 shadow-sm">
					<span className="size-2 rounded-full bg-amber-400" />
					<span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
						Local demo · no network
					</span>
				</div>
			</div>

			<div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.55fr)]">
				<ProjectStatusCard project={DEMO_PROJECT} />
				<section className="rounded-[28px] border border-border/70 bg-card p-5 shadow-sm sm:p-6">
					<div className="flex items-start justify-between gap-3">
						<div>
							<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
								Delivery posture
							</p>
							<h2 className="mt-2 font-medium text-lg tracking-tight">
								{modeCopy.label}
							</h2>
						</div>
						<StatusPill label="Preview only" tone="warning" />
					</div>
					<p className="mt-3 text-muted-foreground text-sm leading-relaxed">
						{modeCopy.detail}. Switching this demo changes the explanation,
						never a live connection.
					</p>
					<div className="mt-5">
						<DeliveryModeSelector mode={mode} onChange={onModeChange} />
					</div>
					<div className="mt-5 rounded-2xl border border-border/70 bg-muted/45 p-4">
						<div className="flex items-start gap-3">
							<span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
								<HugeiconsIcon
									aria-hidden="true"
									icon={
										mode === "preview"
											? Clock01Icon
											: mode === "byo"
												? AlertCircleIcon
												: CheckmarkCircle02Icon
									}
								/>
							</span>
							<p className="text-muted-foreground text-xs leading-relaxed">
								{mode === "preview"
									? "Local preview URLs are diagnostic only and do not become production Site URLs."
									: null}
								{mode === "byo"
									? "The operator owns the relay, DNS, TLS, and egress bill. Ryu still owns route identity."
									: null}
								{mode === "managed"
									? "Ryu owns the wildcard edge and stable hostname; this screen is still a local status preview."
									: null}
							</p>
						</div>
					</div>
				</section>
			</div>

			<section className="space-y-4">
				<SectionHeading
					eyebrow="Usage at a glance"
					muted="Plan limits are visible before publish"
					title="Quotas stay explicit"
				/>
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					{DEMO_QUOTAS.map((quota) => (
						<QuotaCard key={quota.id} quota={quota} />
					))}
				</div>
			</section>

			<div className="grid gap-4 xl:grid-cols-2">
				<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
					<SectionHeading
						eyebrow="Public route"
						muted="Host + path lease"
						title="One site, many safe targets"
					/>
					<div className="mt-5 space-y-1">
						{DEMO_ROUTES.slice(0, 2).map((route) => (
							<RouteRow key={route.routeId} route={route} />
						))}
					</div>
				</section>
				<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
					<SectionHeading
						eyebrow="Custom domains"
						muted="No false Live states"
						title="Verification is two-step"
					/>
					<div className="mt-5 space-y-1">
						{DEMO_DOMAINS.map((domain) => (
							<DomainRow domain={domain} key={domain.domain} />
						))}
					</div>
				</section>
			</div>
		</div>
	);
}

function ProjectsView() {
	return (
		<div className="mx-auto w-full max-w-[1320px] space-y-7 px-5 py-7 sm:px-8">
			<SectionHeading
				eyebrow="Project registry"
				muted="Deterministic local records"
				title="Projects and immutable deployments"
			/>
			<section className="rounded-[28px] border border-border/70 bg-card p-5 shadow-sm sm:p-7">
				<div className="flex flex-wrap items-start justify-between gap-4 border-border/70 border-b pb-6">
					<div className="flex items-start gap-4">
						<span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 font-medium text-primary">
							N
						</span>
						<div>
							<div className="flex flex-wrap items-center gap-2">
								<h1 className="font-medium text-xl tracking-tight">
									{DEMO_PROJECT.name}
								</h1>
								<StatusPill label={DEMO_PROJECT.status} tone="success" />
							</div>
							<p className="mt-1 text-muted-foreground text-sm">
								{DEMO_PROJECT.sourceKind.replace("-", " ")} · updated today
							</p>
						</div>
					</div>
					<div className="rounded-xl border border-border/70 bg-muted/45 px-3 py-2 font-mono text-muted-foreground text-xs">
						{DEMO_PROJECT.id}
					</div>
				</div>
				<div className="mt-6 grid gap-4 md:grid-cols-3">
					<div className="rounded-2xl bg-muted/45 p-4">
						<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
							Managed preview
						</p>
						<p className="mt-2 break-all font-mono text-sm">
							{DEMO_MANAGED_ORIGIN}
						</p>
						<p className="mt-2 text-muted-foreground text-xs">
							Stable origin preview under the wildcard edge.
						</p>
					</div>
					<div className="rounded-2xl bg-muted/45 p-4">
						<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
							Current deployment
						</p>
						<p className="mt-2 font-medium text-sm">Version 7 · ready</p>
						<p className="mt-2 text-muted-foreground text-xs">
							{DEMO_PROJECT.currentDeploymentId}
						</p>
					</div>
					<div className="rounded-2xl bg-muted/45 p-4">
						<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
							Source boundary
						</p>
						<p className="mt-2 font-medium text-sm">Local project</p>
						<p className="mt-2 text-muted-foreground text-xs">
							Source stays private until an explicit publish flow exists.
						</p>
					</div>
				</div>
			</section>
			<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
				<SectionHeading
					eyebrow="Deployment history"
					muted="Deployments are immutable"
					title="Versions"
				/>
				<div className="mt-5 space-y-1">
					{DEMO_DEPLOYMENTS.map((deployment) => (
						<DeploymentRow
							deployment={deployment}
							key={deployment.deploymentId}
						/>
					))}
				</div>
			</section>
		</div>
	);
}

function DeploymentRow({ deployment }: { deployment: SiteDeployment }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-border/60 border-b py-3 first:pt-0 last:border-0 last:pb-0">
			<div className="flex items-center gap-3">
				<span className="flex size-8 items-center justify-center rounded-xl bg-muted font-mono text-xs">
					v{deployment.version}
				</span>
				<div>
					<p className="font-medium text-sm">{deployment.buildId}</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{deployment.entrypoint} · created today
					</p>
				</div>
			</div>
			<StatusPill
				label={deployment.status}
				tone={deployment.status === "ready" ? "success" : "neutral"}
			/>
		</div>
	);
}

function EdgeView() {
	return (
		<div className="mx-auto w-full max-w-[1320px] space-y-7 px-5 py-7 sm:px-8">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<SectionHeading
					eyebrow="Public Edge"
					muted="One node connection, many route leases"
					title="Connectors and routes"
				/>
				<StatusPill label="No live connection" tone="warning" />
			</div>
			<section className="grid gap-4 lg:grid-cols-2">
				{DEMO_CONNECTORS.map((connector) => (
					<ConnectorCard connector={connector} key={connector.connectorId} />
				))}
			</section>
			<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
				<SectionHeading
					eyebrow="Route leases"
					muted="Matches host + path prefix"
					title="Public requests stay bound"
				/>
				<div className="mt-5 space-y-1">
					{DEMO_ROUTES.map((route) => (
						<RouteRow key={route.routeId} route={route} />
					))}
				</div>
			</section>
			<section className="rounded-2xl border border-sky-200/70 bg-sky-50/70 p-5 text-sky-950 sm:p-6">
				<div className="flex items-start gap-3">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-sky-600 shadow-sm">
						<HugeiconsIcon aria-hidden="true" icon={AlertCircleIcon} />
					</span>
					<div>
						<p className="font-medium text-sm">
							The demo never opens a public port.
						</p>
						<p className="mt-1 text-sky-900/70 text-xs leading-relaxed">
							Connector tokens, relay credentials, and local target ports belong
							to the future authoritative seam; this slice renders route posture
							only.
						</p>
					</div>
				</div>
			</section>
		</div>
	);
}

function WidgetPreview({
	tab,
	onTabChange,
}: {
	tab: WidgetTab;
	onTabChange: (tab: WidgetTab) => void;
}) {
	const tabCopy: Record<WidgetTab, { description: string; title: string }> = {
		ask: {
			description:
				"Ask a question and get a grounded answer from published Help Center articles.",
			title: "What can we help you find?",
		},
		contact: {
			description:
				"Send context to the team when the published answers do not cover your question.",
			title: "Talk to the team",
		},
		help: {
			description:
				"Browse the small set of published articles that visitors can see.",
			title: "Browse help",
		},
	};

	return (
		<div className="mx-auto w-full max-w-[1320px] space-y-7 px-5 py-7 sm:px-8">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
						Help Center integration
					</p>
					<h1 className="mt-2 font-medium text-3xl tracking-[-0.04em]">
						A widget with a safe public boundary.
					</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-relaxed">
						Preview the visitor experience and the exact browser snippet without
						exposing operator or Space credentials.
					</p>
				</div>
				<StatusPill label="Local preview only" tone="warning" />
			</div>

			<div className="grid gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(360px,1.08fr)]">
				<section
					className="rounded-[28px] border border-border/70 bg-slate-950 p-4 shadow-slate-950/10 shadow-xl sm:p-6"
					data-testid="sites-widget-preview"
				>
					<div className="mx-auto max-w-[420px] overflow-hidden rounded-[24px] border border-white/10 bg-white text-slate-950 shadow-2xl">
						<div className="flex items-center justify-between border-slate-200 border-b px-5 py-4">
							<div className="flex items-center gap-2">
								<span className="flex size-8 items-center justify-center rounded-xl bg-sky-500 font-medium text-white text-xs">
									R
								</span>
								<div>
									<p className="font-medium text-sm">Northstar Help</p>
									<p className="text-[10px] text-slate-500">
										Powered by a published Site
									</p>
								</div>
							</div>
							<span className="rounded-full bg-amber-50 px-2 py-1 font-mono text-[9px] text-amber-700 uppercase tracking-[0.1em]">
								demo
							</span>
						</div>
						<div className="grid grid-cols-3 border-slate-200 border-b p-1">
							{(["ask", "help", "contact"] as WidgetTab[]).map((option) => (
								<Button
									aria-selected={tab === option}
									className="rounded-xl text-xs capitalize"
									key={option}
									onClick={() => onTabChange(option)}
									role="tab"
									size="sm"
									type="button"
									variant={tab === option ? "mono" : "ghost"}
								>
									{option}
								</Button>
							))}
						</div>
						<div className="min-h-[290px] p-5">
							<p className="font-mono text-[10px] text-slate-400 uppercase tracking-[0.14em]">
								{tabCopy[tab].title}
							</p>
							<p className="mt-3 font-medium text-2xl tracking-[-0.04em]">
								{tabCopy[tab].description}
							</p>
							{tab === "ask" ? (
								<div className="mt-7 space-y-3">
									<div className="rounded-2xl bg-slate-100 px-4 py-3 text-slate-500 text-xs">
										How do I export a report?
									</div>
									<div className="rounded-2xl bg-sky-50 px-4 py-3 text-sky-900 text-xs leading-relaxed">
										Try searching published articles first. This answer is a
										static preview, not a live AI request.
									</div>
								</div>
							) : null}
							{tab === "help" ? (
								<div className="mt-7 space-y-2">
									{[
										"Exporting a report from Ryu",
										"Managing workspace access",
									].map((article) => (
										<div
											className="flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3 text-xs"
											key={article}
										>
											<span>{article}</span>
											<HugeiconsIcon
												aria-hidden="true"
												icon={ArrowRight01Icon}
											/>
										</div>
									))}
								</div>
							) : null}
							{tab === "contact" ? (
								<div className="mt-7 space-y-3">
									<div className="rounded-2xl border border-slate-200 px-4 py-3 text-slate-400 text-xs">
										you@example.com
									</div>
									<div className="rounded-2xl border border-slate-200 px-4 py-4 text-slate-400 text-xs">
										Tell us what you need help with…
									</div>
									<div className="rounded-2xl bg-slate-950 px-4 py-3 text-center font-medium text-white text-xs">
										Preview contact form
									</div>
								</div>
							) : null}
						</div>
					</div>
					<p className="mx-auto mt-4 max-w-[420px] text-center text-slate-400 text-xs">
						Ask, Help, and Contact are preview states. No visitor request leaves
						this companion.
					</p>
				</section>

				<section className="space-y-4">
					<WidgetSnippetCard />
					<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
						<SectionHeading
							eyebrow="Public boundary"
							muted="Safe by construction"
							title="Only two dynamic values"
						/>
						<div className="mt-5 space-y-2">
							<div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-3 text-xs">
								<span className="text-muted-foreground">
									Managed Site origin
								</span>
								<span className="break-all text-right font-mono">
									{DEMO_MANAGED_ORIGIN}
								</span>
							</div>
							<div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-3 text-xs">
								<span className="text-muted-foreground">Public site key</span>
								<span className="font-mono">site_public_northstar_demo</span>
							</div>
						</div>
						<p className="mt-4 text-muted-foreground text-xs leading-relaxed">
							Never included: node token, Cloudflare credential, Space id,
							private deployment id, or relay key.
						</p>
					</section>
				</section>
			</div>
		</div>
	);
}

function WidgetSnippetCard() {
	const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
	const snippet = useMemo(
		() => widgetScriptSnippet(DEMO_PROJECT, "site_public_northstar_demo"),
		[]
	);

	const copySnippet = async (): Promise<void> => {
		if (!navigator.clipboard) {
			setCopyStatus("unavailable");
			return;
		}
		try {
			await navigator.clipboard.writeText(snippet);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("unavailable");
		}
	};

	return (
		<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
						Install preview
					</p>
					<h2 className="mt-2 font-medium text-lg tracking-tight">
						Safe widget snippet
					</h2>
				</div>
				<StatusPill label="Copyable" tone="success" />
			</div>
			<p className="mt-3 text-muted-foreground text-sm leading-relaxed">
				This is the exact browser-facing payload for the demo Site. It contains
				no operator credential.
			</p>
			<pre
				className="mt-5 overflow-x-auto rounded-2xl bg-slate-950 p-4 font-mono text-[11px] text-sky-100 leading-relaxed"
				data-testid="sites-widget-snippet"
			>
				<code>{snippet}</code>
			</pre>
			<div className="mt-3 flex flex-wrap items-center justify-between gap-3">
				<Button
					onClick={() => void copySnippet()}
					size="sm"
					type="button"
					variant="mono"
				>
					{copyStatus === "copied" ? "Copied" : "Copy snippet"}
				</Button>
				<p className="text-muted-foreground text-xs">
					{copyStatus === "unavailable"
						? "Clipboard is unavailable in this preview."
						: "Managed origin + public key only."}
				</p>
			</div>
		</section>
	);
}

export function SitesApp() {
	const [view] = useState<SitesView>(() => contextView() ?? "overview");
	const [mode, setMode] = useState<DeliveryMode>("managed");
	const [widgetTab, setWidgetTab] = useState<WidgetTab>("ask");

	return (
		<div
			className="flex h-full min-h-0 overflow-hidden bg-background"
			data-testid="sites-app"
		>
			<main className="min-w-0 flex-1 overflow-y-auto">
				<div className="flex min-h-12 items-center justify-between border-border/70 border-b bg-card/80 px-5 py-3 backdrop-blur sm:px-8">
					<div className="flex items-center gap-2 text-xs">
						<span className="text-muted-foreground">Sites</span>
						<span className="text-border">/</span>
						<span className="font-medium capitalize">
							{view === "edge" ? "public edge" : view}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<span className="hidden font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em] sm:inline">
							@ryu/sites · 0.1.0
						</span>
						<StatusPill label="Demo data" tone="warning" />
					</div>
				</div>
				{view === "overview" ? (
					<OverviewView mode={mode} onModeChange={setMode} />
				) : null}
				{view === "projects" ? <ProjectsView /> : null}
				{view === "edge" ? <EdgeView /> : null}
				{view === "widget" ? (
					<WidgetPreview onTabChange={setWidgetTab} tab={widgetTab} />
				) : null}
			</main>
		</div>
	);
}
