export type { ServiceStatus } from "./schemas.ts";

import {
	RyuAppEmpty,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Badge,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
	Textarea,
} from "@ryu/blocks/companion/controls";
import { useEffect, useState } from "react";
import type {
	ResetActionResult,
	ResetProvider,
	RuntimeSite,
	SiteSettings,
} from "../../sidecar/src/contracts.ts";
import { siteSettings, siteSharedData } from "../../sidecar/src/contracts.ts";
import type { SiteDataRecord } from "../../sidecar/src/data-values.ts";
import { siteDataValueSchema } from "../../sidecar/src/data-values.ts";
import styles from "./analytics.module.css";
import { projectPath, sitesRequest } from "./api.ts";
import type { AnalyticsReport, ServiceStatus } from "./schemas.ts";
import {
	analyticsReportSchema,
	resetActionResultSchema,
	runtimeSiteSchema,
} from "./schemas.ts";

type Run = (work: () => Promise<void>) => Promise<void>;
export function CreateSiteDialog({
	open,
	setOpen,
	busy,
	run,
	onCreate,
	initialTemplate = "help-center",
}: {
	open: boolean;
	setOpen: (value: boolean) => void;
	busy: boolean;
	run: Run;
	onCreate: (site: RuntimeSite) => Promise<void>;
	/** The template preselected when the dialog opens, e.g. from the Gallery. */
	initialTemplate?: RuntimeSite["template"];
}) {
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [template, setTemplate] = useState<string>(initialTemplate);
	const [prompt, setPrompt] = useState("");
	const [dialogError, setDialogError] = useState("");
	useEffect(() => {
		if (open) {
			setTemplate(initialTemplate);
		}
	}, [open, initialTemplate]);
	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (nextOpen) {
					setDialogError("");
				}
				setOpen(nextOpen);
			}}
			open={open}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create a site</DialogTitle>
					<DialogDescription>
						Start private with a useful template. Deploy only when ready.
					</DialogDescription>
				</DialogHeader>
				{dialogError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{dialogError}
					</p>
				) : null}
				<RyuAppField label="Name">
					<Input
						aria-label="Site name"
						onChange={(event) => {
							setName(event.target.value);
							setSlug(
								event.target.value
									.toLowerCase()
									.replace(/[^a-z0-9]+/g, "-")
									.replace(/^-|-$/g, "")
							);
						}}
						value={name}
					/>
				</RyuAppField>
				<RyuAppField label="URL name">
					<Input
						aria-label="URL name"
						onChange={(event) => setSlug(event.target.value)}
						value={slug}
					/>
				</RyuAppField>
				<RyuAppField label="Template">
					<Select onValueChange={setTemplate} value={template}>
						<SelectTrigger aria-label="Template">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{[
								"help-center",
								"website",
								"dashboard",
								"game",
								"reset-calendar",
							].map((item) => (
								<SelectItem key={item} value={item}>
									{item}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</RyuAppField>
				<RyuAppField label="Description">
					<Textarea
						aria-label="Description"
						onChange={(event) => setPrompt(event.target.value)}
						value={prompt}
					/>
				</RyuAppField>
				<DialogFooter>
					<Button onClick={() => setOpen(false)} variant="outline">
						Cancel
					</Button>
					<Button
						disabled={busy || !name.trim() || slug.length < 5}
						onClick={() =>
							void run(async () => {
								setDialogError("");
								let created: RuntimeSite;
								try {
									created = await sitesRequest(
										runtimeSiteSchema,
										"/projects",
										"POST",
										{ name, slug, template, prompt }
									);
								} catch (cause) {
									setDialogError(
										cause instanceof Error
											? cause.message
											: "The site could not be created."
									);
									return;
								}
								await onCreate(created);
							})
						}
					>
						Create site
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
export function SiteSettingsPanel({
	site,
	status,
	busy,
	run,
	replace,
	onDelete,
}: {
	site: RuntimeSite;
	status: ServiceStatus;
	busy: boolean;
	run: Run;
	replace: (site: RuntimeSite) => void;
	onDelete: () => void;
}) {
	const [settings, setSettings] = useState<SiteSettings>(site.settings);
	const [name, setName] = useState(site.name);
	const [slug, setSlug] = useState(site.slug);
	const [domain, setDomain] = useState("");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const [resetProvider, setResetProvider] = useState<ResetProvider | null>(
		null
	);
	const [resetReport, setResetReport] = useState<ResetActionResult | null>(
		null
	);
	const update = (patch: Partial<SiteSettings>) =>
		setSettings((current) => ({ ...current, ...patch }));
	const mutate = (
		action: string,
		method: "POST" | "PUT" | "DELETE",
		body: SiteDataRecord
	) =>
		run(async () =>
			replace(
				await sitesRequest(
					runtimeSiteSchema,
					projectPath(site, action),
					method,
					{
						...body,
						expectedRevision: site.revision,
					}
				)
			)
		);
	return (
		<div className="grid gap-8 lg:grid-cols-2">
			<RyuAppSection title="Access and capabilities">
				<RyuAppField label="Who can visit">
					<Select
						onValueChange={(value) =>
							update({ audience: siteSettings.shape.audience.parse(value) })
						}
						value={settings.audience}
					>
						<SelectTrigger aria-label="Who can visit">
							<SelectValue>
								{
									{
										private: "Only the owner",
										invited: "Invited viewers",
										workspace: "Workspace",
										public: "Anyone on the internet",
									}[settings.audience]
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="private">Only the owner</SelectItem>
							<SelectItem disabled={!status.identityAvailable} value="invited">
								Invited viewers
							</SelectItem>
							<SelectItem
								disabled={!status.identityAvailable}
								value="workspace"
							>
								Workspace
							</SelectItem>
							<SelectItem disabled={!status.publicEnabled} value="public">
								Anyone on the internet
							</SelectItem>
						</SelectContent>
					</Select>
				</RyuAppField>
				{status.publicEnabled ? null : (
					<p className="text-muted-foreground text-xs">
						{site.settings.audience === "public"
							? "Public publishing is disabled by the operator, so this Site's public access is suspended. Choose another audience before saving settings."
							: "Public publishing is disabled by the operator."}
					</p>
				)}
				{status.identityAvailable ? (
					<>
						<RyuAppField label="Workspace ID">
							<Input
								aria-label="Workspace ID"
								onChange={(event) =>
									update({ workspaceId: event.target.value || null })
								}
								value={settings.workspaceId ?? ""}
							/>
						</RyuAppField>
						<RyuAppField label="Viewer emails (one per line)">
							<Textarea
								aria-label="Viewer emails (one per line)"
								onChange={(event) =>
									update({
										viewers: event.target.value.split("\n").filter(Boolean),
									})
								}
								value={settings.viewers.join("\n")}
							/>
						</RyuAppField>
						<RyuAppField label="Editor emails (same workspace)">
							<Textarea
								aria-label="Editor emails (same workspace)"
								onChange={(event) =>
									update({
										editors: event.target.value.split("\n").filter(Boolean),
									})
								}
								value={settings.editors.join("\n")}
							/>
						</RyuAppField>
					</>
				) : (
					<p className="text-muted-foreground text-xs">
						Connect platform identity to enable sign-in and private visitor
						sharing.
					</p>
				)}
				<RyuAppField label="Data runtime">
					<Select
						onValueChange={(value) =>
							update({ mode: siteSettings.shape.mode.parse(value) })
						}
						value={settings.mode}
					>
						<SelectTrigger aria-label="Data runtime">
							<SelectValue>
								{settings.mode === "local"
									? "Browser-local"
									: "Connected to Ryu"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="local">Browser-local</SelectItem>
							<SelectItem value="connected">Connected to Ryu</SelectItem>
						</SelectContent>
					</Select>
				</RyuAppField>
				<p className="text-muted-foreground text-xs">
					Changing runtime never uploads browser data. Connected records and
					files require a signed-in visitor.
				</p>
				{settings.storage && !settings.database ? (
					<p className="text-sm text-status-warning">
						Connect a Ryu Spaces database in the Database section before saving.
					</p>
				) : null}
				{(
					[
						["storage", "Durable records"],
						["ai", "AI for visitors"],
						["uploads", "File uploads"],
						["optionalSignIn", "Optional visitor sign-in"],
					] as const
				).map(([key, label]) => (
					<div className="flex items-center justify-between gap-3" key={key}>
						<Label htmlFor={key}>{label}</Label>
						<Switch
							checked={settings[key]}
							disabled={
								(key === "optionalSignIn" && !status.identityAvailable) ||
								(key === "storage" && !settings.database) ||
								(key === "ai" &&
									!settings.ai &&
									!(status.answersAvailable || status.completionsAvailable))
							}
							id={key}
							onCheckedChange={(value) => update({ [key]: value })}
						/>
					</div>
				))}
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-3">
						<Label htmlFor="allow-remix">Allow remixing</Label>
						<Switch
							checked={settings.allowRemix}
							id="allow-remix"
							onCheckedChange={(value) => update({ allowRemix: value })}
						/>
					</div>
					<p className="text-muted-foreground text-xs">
						Anyone who can visit may start their own private copy of the
						deployed version from the Gallery. Sharing, editors, domains,
						connections, data and analytics are never copied.
					</p>
				</div>
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-3">
						<Label htmlFor="shared-data">Shared visitor data</Label>
						<Switch
							checked={settings.sharedData.enabled}
							disabled={
								!(
									settings.sharedData.enabled ||
									(settings.database &&
										settings.mode === "connected" &&
										status.identityAvailable)
								)
							}
							id="shared-data"
							onCheckedChange={(value) =>
								update({
									sharedData: { ...settings.sharedData, enabled: value },
								})
							}
						/>
					</div>
					<p className="text-muted-foreground text-xs">
						{settings.database &&
						settings.mode === "connected" &&
						status.identityAvailable
							? "Records every visitor of this Site sees together, with live updates. Authors, editors and you can change or remove a record."
							: "Shared visitor data needs the Connected to Ryu runtime, a connected database and platform identity."}
					</p>
					{settings.sharedData.enabled ? (
						<RyuAppField label="Who can add shared records">
							<Select
								onValueChange={(value) =>
									update({
										sharedData: {
											...settings.sharedData,
											write: siteSharedData.shape.write.parse(value),
										},
									})
								}
								value={settings.sharedData.write}
							>
								<SelectTrigger aria-label="Who can add shared records">
									<SelectValue>
										{settings.sharedData.write === "editors"
											? "Editors only"
											: "Signed-in visitors"}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="signed-in">Signed-in visitors</SelectItem>
									<SelectItem value="editors">Editors only</SelectItem>
								</SelectContent>
							</Select>
						</RyuAppField>
					) : null}
				</div>
				{site.template === "reset-calendar" ? (
					<div className="flex flex-col gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3">
						<div className="flex items-center justify-between gap-3">
							<Label htmlFor="agent-actions">Owner reset checks</Label>
							<Switch
								checked={settings.agentActions}
								disabled={!status.agentAvailable}
								id="agent-actions"
								onCheckedChange={(value) => update({ agentActions: value })}
							/>
						</div>
						<p className="text-muted-foreground text-xs">
							{status.agentAvailable
								? "Save this setting, then choose a provider here to check your connected account. Results stay in Ryu."
								: "Ryu agent execution is not connected on this node, so reset actions stay disabled."}
						</p>
						<div className="flex flex-wrap gap-2">
							{(["codex", "claude", "copilot"] as const).map((provider) => (
								<Button
									disabled={
										busy ||
										!status.agentAvailable ||
										!site.settings.agentActions
									}
									key={provider}
									onClick={() => setResetProvider(provider)}
									size="sm"
									variant="outline"
								>
									Check{" "}
									{
										{
											codex: "Codex",
											claude: "Claude Code",
											copilot: "GitHub Copilot",
										}[provider]
									}
								</Button>
							))}
						</div>
						{resetReport ? (
							<p
								className="whitespace-pre-wrap break-words text-sm"
								role="status"
							>
								{resetReport.detail}
							</p>
						) : null}
					</div>
				) : null}
				{settings.ai ? (
					<div className="flex flex-col gap-2">
						<RyuAppField label="AI mode">
							<Select
								onValueChange={(value) =>
									update({ aiMode: siteSettings.shape.aiMode.parse(value) })
								}
								value={settings.aiMode}
							>
								<SelectTrigger aria-label="AI mode">
									<SelectValue>
										{settings.aiMode === "general"
											? "General page AI"
											: "Grounded answers"}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="grounded">Grounded answers</SelectItem>
									<SelectItem
										disabled={!status.completionsAvailable}
										value="general"
									>
										General page AI
									</SelectItem>
								</SelectContent>
							</Select>
						</RyuAppField>
						<p className="text-muted-foreground text-xs">
							{settings.aiMode === "general"
								? "The page can call the Ryu model for its own tasks, such as summaries, classification or a chat widget. No knowledge Space is needed. Calls share the daily limit below."
								: "Answers come only from the bound knowledge Space, with source citations."}
						</p>
						{status.completionsAvailable ? null : (
							<p className="text-muted-foreground text-xs">
								General page AI needs a Ryu model connected to this node.
							</p>
						)}
						{settings.aiMode === "general" ? (
							<>
								<div className="flex items-center justify-between gap-3">
									<Label htmlFor="ai-anonymous">
										Allow AI without visitor sign-in
									</Label>
									<Switch
										checked={settings.aiAnonymous}
										id="ai-anonymous"
										onCheckedChange={(value) => update({ aiAnonymous: value })}
									/>
								</div>
								<p className="text-muted-foreground text-xs">
									Off by default. When on, anyone who can visit may spend this
									Site's daily AI limit.
								</p>
								<RyuAppField label="Owner AI instructions">
									<Textarea
										aria-label="Owner AI instructions"
										maxLength={4000}
										onChange={(event) =>
											update({ aiSystemPrompt: event.target.value })
										}
										placeholder="For example: Answer briefly and only about our products."
										value={settings.aiSystemPrompt}
									/>
								</RyuAppField>
								<p className="text-muted-foreground text-xs">
									Always applied before the page's own instructions. Visitors
									cannot replace them, but the model may repeat them, so keep
									secrets out.
								</p>
							</>
						) : null}
					</div>
				) : null}
				{settings.ai ? (
					<RyuAppField label="Daily answer limit">
						<Input
							aria-label="Daily answer limit"
							max={1000}
							min={1}
							onChange={(event) =>
								update({ aiDailyLimit: Number(event.target.value) })
							}
							type="number"
							value={settings.aiDailyLimit}
						/>
					</RyuAppField>
				) : null}
				<RyuAppField label="Knowledge Space binding">
					<Input
						aria-label="Knowledge Space binding"
						disabled={!status.retrievalAvailable}
						onChange={(event) =>
							update({ spaceId: event.target.value || null })
						}
						placeholder={
							status.retrievalAvailable
								? "Approved Space ID"
								: "Retrieval service not connected"
						}
						value={settings.spaceId ?? ""}
					/>
				</RyuAppField>
				<Button
					disabled={busy}
					onClick={() => void mutate("settings", "PUT", { settings })}
				>
					Save settings
				</Button>
			</RyuAppSection>
			<RyuAppSection title="General and domains">
				<RyuAppField label="Name">
					<Input
						aria-label="Site name"
						onChange={(event) => setName(event.target.value)}
						value={name}
					/>
				</RyuAppField>
				<Button
					disabled={busy || !name.trim() || name === site.name}
					onClick={() => void mutate("name", "PUT", { name })}
					variant="outline"
				>
					Save name
				</Button>
				<RyuAppField label="Site URL name">
					<Input
						aria-label="Site URL name"
						onChange={(event) => setSlug(event.target.value)}
						value={slug}
					/>
				</RyuAppField>
				<Button
					disabled={busy || slug === site.slug}
					onClick={() => void mutate("url", "PUT", { slug })}
					variant="outline"
				>
					Change URL
				</Button>
				<p className="text-muted-foreground text-xs">
					Old names redirect to the new name. Custom domains are separate.
				</p>
				<RyuAppField label="Custom domain">
					<Input
						aria-label="Custom domain"
						onChange={(event) => setDomain(event.target.value)}
						placeholder="help.example.com"
						value={domain}
					/>
				</RyuAppField>
				<Button
					disabled={busy || !domain || status.domainsAvailable !== true}
					onClick={() => void mutate("domains", "POST", { host: domain })}
					variant="outline"
				>
					Add domain
				</Button>
				{status.domainsAvailable === true ? null : (
					<p className="text-muted-foreground text-xs">
						No edge or TLS provider is configured on this node, so custom
						domains stay pending TLS and do not serve traffic.
					</p>
				)}
				{site.domains.map((binding) => (
					<section className="rounded-lg border p-3" key={binding.host}>
						<p>
							{binding.host}{" "}
							<Badge variant="outline">
								{binding.status.replaceAll("_", " ")}
							</Badge>
						</p>
						<p className="mt-2 break-all text-xs">
							TXT _ryu-sites.{binding.host} = {binding.verification}
						</p>
						<div className="mt-3 flex gap-2">
							<Button
								disabled={busy}
								onClick={() =>
									void mutate("domains/check", "POST", { host: binding.host })
								}
								size="sm"
								variant="outline"
							>
								Check DNS and TLS
							</Button>
							<Button
								disabled={busy}
								onClick={() =>
									void mutate("domains", "DELETE", { host: binding.host })
								}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</div>
					</section>
				))}
				<p className="text-muted-foreground text-xs">
					Live requires both ownership verification and an active TLS/edge
					binding.
				</p>
				<Button
					disabled={busy || !site.deploymentId}
					onClick={() => void mutate("unpublish", "POST", {})}
					variant="outline"
				>
					Take site offline
				</Button>
				<Button
					disabled={busy}
					onClick={() => setDeleteOpen(true)}
					variant="destructive"
				>
					Delete site
				</Button>
			</RyuAppSection>
			<RyuAppSection title="Environment variables">
				<RyuAppEmpty
					description="Sites currently serves static visitor pages. API keys and private environment values cannot be used there safely yet. Keep secrets out of generated HTML."
					title="Server-side variables unavailable"
				/>
			</RyuAppSection>
			<Dialog
				onOpenChange={(open) => {
					if (!(open || busy)) {
						setResetProvider(null);
					}
				}}
				open={resetProvider !== null}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Check{" "}
							{resetProvider
								? {
										codex: "Codex",
										claude: "Claude Code",
										copilot: "GitHub Copilot",
									}[resetProvider]
								: "provider"}{" "}
							reset?
						</DialogTitle>
						<DialogDescription>
							Run one bounded agent check for your connected account on{" "}
							{site.name}. Ryu checks the provider's current usage first. A
							reset can be redeemed only through a separately authorized
							provider action.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							disabled={busy}
							onClick={() => setResetProvider(null)}
							variant="outline"
						>
							Cancel
						</Button>
						<Button
							disabled={busy || resetProvider === null}
							onClick={() => {
								const provider = resetProvider;
								if (!provider) {
									return;
								}
								setResetReport(null);
								void run(async () => {
									const result = await sitesRequest(
										resetActionResultSchema,
										projectPath(site, "reset"),
										"POST",
										{ provider, expectedRevision: site.revision }
									);
									setResetReport(result);
									setResetProvider(null);
								});
							}}
						>
							Run account check
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Permanently delete {site.name}?</DialogTitle>
						<DialogDescription>
							Versions, records, uploads, and analytics will be removed. Type{" "}
							{site.slug} to confirm.
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="Confirm site URL name"
						onChange={(event) => setConfirmation(event.target.value)}
						value={confirmation}
					/>
					<DialogFooter>
						<Button onClick={() => setDeleteOpen(false)} variant="outline">
							Cancel
						</Button>
						<Button
							disabled={busy || confirmation !== site.slug}
							onClick={() =>
								void run(async () => {
									await sitesRequest(
										siteDataValueSchema,
										projectPath(site),
										"DELETE",
										{
											slug: confirmation,
											expectedRevision: site.revision,
										}
									);
									onDelete();
								})
							}
							variant="destructive"
						>
							Permanently delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function Analytics({ site }: { site: RuntimeSite }) {
	const [report, setReport] = useState<AnalyticsReport | null>(null);
	const [days, setDays] = useState("7");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		void sitesRequest(
			analyticsReportSchema,
			`${projectPath(site, "analytics")}?days=${days}`
		)
			.then((data) => {
				if (active) {
					setReport(data);
				}
			})
			.catch((cause) => {
				if (active) {
					setError(
						cause instanceof Error ? cause.message : "Analytics unavailable"
					);
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [site.id, days]);
	const dayCount = Number(days);
	const rowByDay = new Map(report?.daily.map((row) => [row.day, row]) ?? []);
	const points = Array.from({ length: dayCount }, (_, index) => {
		const date = new Date(Date.now() - (dayCount - index - 1) * 86_400_000)
			.toISOString()
			.slice(0, 10);
		return rowByDay.get(date) ?? { day: date, pageViews: 0, uniqueVisitors: 0 };
	});
	const maxValue = Math.max(
		1,
		...points.map((point) => Math.max(point.pageViews, point.uniqueVisitors))
	);
	const xFor = (index: number) =>
		62 + (index / Math.max(1, points.length - 1)) * 900;
	const yFor = (value: number) => 205 - (value / maxValue) * 170;
	const visitorLine = points
		.map((point, index) => `${xFor(index)},${yFor(point.uniqueVisitors)}`)
		.join(" ");
	const pageLine = points
		.map((point, index) => `${xFor(index)},${yFor(point.pageViews)}`)
		.join(" ");
	const labels = [
		points[0],
		points[Math.floor(points.length / 2)],
		points.at(-1),
	].filter((point): point is (typeof points)[number] => point !== undefined);
	return (
		<div className="grid gap-5">
			<RyuAppSection title="Traffic">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-muted-foreground text-sm">
						Daily page requests and estimated unique visitors. No tracking
						cookie or analytics SDK; data is retained for 90 days.
					</p>
					<Select onValueChange={setDays} value={days}>
						<SelectTrigger aria-label="Analytics date range" className="w-36">
							<SelectValue>Last {days} days</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="7">Last 7 days</SelectItem>
							<SelectItem value="30">Last 30 days</SelectItem>
							<SelectItem value="90">Last 90 days</SelectItem>
						</SelectContent>
					</Select>
				</div>
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				{loading ? (
					<p className="text-muted-foreground text-sm" role="status">
						Loading analytics…
					</p>
				) : report?.summary.pageViews ? (
					<>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="rounded-lg border p-4">
								<p className="text-muted-foreground text-sm">Unique visitors</p>
								<p className="mt-1 font-medium text-2xl tabular-nums">
									{report.summary.uniqueVisitors}
								</p>
							</div>
							<div className="rounded-lg border p-4">
								<p className="text-muted-foreground text-sm">Page views</p>
								<p className="mt-1 font-medium text-2xl tabular-nums">
									{report.summary.pageViews}
								</p>
							</div>
						</div>
						<div className="rounded-lg border p-4">
							<p className="font-medium text-sm">Traffic over time</p>
							<p className="text-muted-foreground text-xs">Daily · UTC</p>
							<svg
								aria-label={`Daily page views and unique visitors over ${days} days`}
								className="mt-3 w-full"
								role="img"
								viewBox="0 0 1000 250"
							>
								{[0, Math.floor(maxValue / 2), maxValue].map((tick, index) => {
									const y = yFor(tick);
									return (
										<g key={`${tick}-${index}`}>
											<line
												className="stroke-border"
												x1="54"
												x2="964"
												y1={y}
												y2={y}
											/>
											<text
												className={`fill-muted-foreground ${styles.axisLabel}`}
												textAnchor="end"
												x="45"
												y={y + 4}
											>
												{tick}
											</text>
										</g>
									);
								})}
								<polyline
									fill="none"
									points={visitorLine}
									stroke="var(--primary)"
									strokeWidth="3"
								/>
								<polyline
									fill="none"
									points={pageLine}
									stroke="var(--chart-2)"
									strokeWidth="3"
								/>
								{labels.map((point, index) => (
									<text
										className={`fill-muted-foreground ${styles.axisLabel}`}
										key={`${point.day}-${index}`}
										textAnchor={
											index === 0
												? "start"
												: index === labels.length - 1
													? "end"
													: "middle"
										}
										x={xFor(
											points.findIndex(
												(candidate) => candidate.day === point.day
											)
										)}
										y="235"
									>
										{new Date(`${point.day}T12:00:00Z`).toLocaleDateString(
											undefined,
											{ month: "short", day: "numeric", timeZone: "UTC" }
										)}
									</text>
								))}
							</svg>
							<div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-primary" />
									Unique visitors
								</span>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-chart-2" />
									Page views
								</span>
							</div>
							<details className="mt-4">
								<summary className="cursor-pointer text-muted-foreground text-sm">
									Daily counts
								</summary>
								<div className="mt-2 max-h-52 overflow-auto">
									<table className="w-full text-left text-sm">
										<thead className="sticky top-0 bg-background">
											<tr>
												<th className="py-2">Day</th>
												<th>Unique visitors</th>
												<th>Page views</th>
											</tr>
										</thead>
										<tbody>
											{points.map((point) => (
												<tr className="border-t" key={point.day}>
													<td className="py-2">{point.day}</td>
													<td>{point.uniqueVisitors}</td>
													<td>{point.pageViews}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</details>
						</div>
					</>
				) : (
					<RyuAppEmpty
						description="Traffic appears after the deployed Site receives visits."
						title="No traffic yet"
					/>
				)}
			</RyuAppSection>
			<RyuAppSection title="Top pages">
				{report?.topPages.length ? (
					<div className="overflow-auto">
						<table className="w-full text-left text-sm">
							<thead>
								<tr>
									<th className="py-3">Page</th>
									<th>Unique visitors</th>
									<th>Page views</th>
								</tr>
							</thead>
							<tbody>
								{report.topPages.map((page) => (
									<tr className="border-t" key={page.path}>
										<td className="max-w-96 truncate py-3" title={page.path}>
											{page.path}
										</td>
										<td>{page.uniqueVisitors}</td>
										<td>{page.pageViews}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<RyuAppEmpty
						description="Page paths appear after visitors load pages from this Site."
						title="No pages to show"
					/>
				)}
			</RyuAppSection>
		</div>
	);
}
