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
import type { RuntimeSite, SiteSettings } from "../../sidecar/src/contracts.ts";
import { projectPath, sitesRequest } from "./api.ts";
export interface ServiceStatus {
	agentAvailable: boolean;
	answersAvailable: boolean;
	baseDomain: string;
	identityAvailable: boolean;
	publicEnabled: boolean;
	retrievalAvailable: boolean;
	scannerAvailable: boolean;
	visitorPort: number;
}
type Run = (work: () => Promise<void>) => Promise<void>;
export function CreateSiteDialog({
	open,
	setOpen,
	busy,
	run,
	onCreate,
}: {
	open: boolean;
	setOpen: (value: boolean) => void;
	busy: boolean;
	run: Run;
	onCreate: (site: RuntimeSite) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [template, setTemplate] = useState("help-center");
	const [prompt, setPrompt] = useState("");
	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create a site</DialogTitle>
					<DialogDescription>
						Start private with a useful template. Deploy only when ready.
					</DialogDescription>
				</DialogHeader>
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
							void run(async () =>
								onCreate(
									await sitesRequest<RuntimeSite>("/projects", "POST", {
										name,
										slug,
										template,
										prompt,
									})
								)
							)
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
	const [slug, setSlug] = useState(site.slug);
	const [domain, setDomain] = useState("");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const update = (patch: Partial<SiteSettings>) =>
		setSettings((current) => ({ ...current, ...patch }));
	const mutate = (
		action: string,
		method: "POST" | "PUT" | "DELETE",
		body: Record<string, unknown>
	) =>
		run(async () =>
			replace(
				await sitesRequest<RuntimeSite>(projectPath(site, action), method, {
					...body,
					expectedRevision: site.revision,
				})
			)
		);
	return (
		<div className="grid gap-8 lg:grid-cols-2">
			<RyuAppSection title="Access and capabilities">
				<RyuAppField label="Who can visit">
					<Select
						onValueChange={(value) =>
							update({ audience: value as SiteSettings["audience"] })
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
						Public publishing is disabled by the operator.
					</p>
				)}
				{status.identityAvailable ? (
					<>
						<RyuAppField label="Workspace ID">
							<Input
								onChange={(event) =>
									update({ workspaceId: event.target.value || null })
								}
								value={settings.workspaceId ?? ""}
							/>
						</RyuAppField>
						<RyuAppField label="Viewer emails (one per line)">
							<Textarea
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
							update({ mode: value as SiteSettings["mode"] })
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
				{(
					[
						["storage", "Durable records"],
						["ai", "Answers from connected knowledge"],
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
								(key === "ai" && !status.answersAvailable)
							}
							id={key}
							onCheckedChange={(value) => update({ [key]: value })}
						/>
					</div>
				))}
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
								? "When enabled, the signed-in owner can press Use reset. Ryu checks the live account first and only follows a real, authorized provider action."
								: "Ryu agent execution is not connected on this node, so reset actions stay disabled."}
						</p>
					</div>
				) : null}
				{settings.ai ? (
					<RyuAppField label="Daily answer limit">
						<Input
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
			<RyuAppSection title="Address and domains">
				<RyuAppField label="Site URL name">
					<Input
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
						onChange={(event) => setDomain(event.target.value)}
						placeholder="help.example.com"
						value={domain}
					/>
				</RyuAppField>
				<Button
					disabled={busy || !domain}
					onClick={() => void mutate("domains", "POST", { host: domain })}
					variant="outline"
				>
					Add domain
				</Button>
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
									await sitesRequest(projectPath(site), "DELETE", {
										slug: confirmation,
										expectedRevision: site.revision,
									});
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
	const [rows, setRows] = useState<
		{ day: string; pageViews: number; uniqueVisitors: number }[]
	>([]);
	const [days, setDays] = useState("7");
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		setError("");
		void sitesRequest<typeof rows>(
			`${projectPath(site, "analytics")}?days=${days}`
		)
			.then((data) => {
				if (active) {
					setRows(data);
				}
			})
			.catch((cause) => {
				if (active) {
					setError(
						cause instanceof Error ? cause.message : "Analytics unavailable"
					);
				}
			});
		return () => {
			active = false;
		};
	}, [site, days]);
	return (
		<RyuAppSection title="Traffic">
			<Select onValueChange={setDays} value={days}>
				<SelectTrigger aria-label="Analytics date range">
					<SelectValue>Last {days} days</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="7">Last 7 days</SelectItem>
					<SelectItem value="30">Last 30 days</SelectItem>
					<SelectItem value="90">Last 90 days</SelectItem>
				</SelectContent>
			</Select>
			{error ? <p role="alert">{error}</p> : null}
			<p className="text-muted-foreground text-sm">
				Page requests and estimated unique visitors per day. No analytics SDK or
				tracking cookie; data is retained for 90 days.
			</p>
			{rows.length ? (
				<table className="w-full text-left text-sm">
					<thead>
						<tr>
							<th className="py-3">Day</th>
							<th>Page views</th>
							<th>Unique visitors</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr className="border-t" key={row.day}>
								<td className="py-3">{row.day}</td>
								<td>{row.pageViews}</td>
								<td>{row.uniqueVisitors}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<RyuAppEmpty
					description="Traffic appears when the deployed site receives visits."
					title="No traffic yet"
				/>
			)}
		</RyuAppSection>
	);
}
