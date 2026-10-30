import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import {
	Button,
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
import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	ResetActionResult,
	ResetProvider,
	RuntimeSite,
	SiteSettings,
} from "../../sidecar/src/contracts.ts";
import { siteSettings, siteSharedData } from "../../sidecar/src/contracts.ts";
import type { SiteDataRecord } from "../../sidecar/src/data-values.ts";
import type { ServiceStatus } from "./schemas.ts";

export function SiteAccessSection({
	site,
	status,
	busy,
	settings,
	update,
	mutate,
	setResetProvider,
	resetReport,
}: {
	site: RuntimeSite;
	status: ServiceStatus;
	busy: boolean;
	settings: SiteSettings;
	update: (patch: Partial<SiteSettings>) => void;
	mutate: (
		action: string,
		method: "POST" | "PUT" | "DELETE",
		body: SiteDataRecord
	) => Promise<void>;
	setResetProvider: (provider: ResetProvider | null) => void;
	resetReport: ResetActionResult | null;
}) {
	const tl = useLiteralMessages();
	return (
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
						<SelectItem disabled={!status.identityAvailable} value="workspace">
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
							{settings.mode === "local" ? "Browser-local" : "Connected to Ryu"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="local">Browser-local</SelectItem>
						<SelectItem value="connected">Connected to Ryu</SelectItem>
					</SelectContent>
				</Select>
			</RyuAppField>
			<p className="text-muted-foreground text-xs">
				Changing runtime never uploads browser data. Connected records and files
				require a signed-in visitor.
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
					Anyone who can visit may start their own private copy of the deployed
					version from the Gallery. Sharing, editors, domains, connections, data
					and analytics are never copied.
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
									busy || !status.agentAvailable || !site.settings.agentActions
								}
								key={provider}
								onClick={() => setResetProvider(provider)}
								size="sm"
								variant="outline"
							>
								{tl("Check {provider}", {
									provider: {
										codex: "Codex",
										claude: "Claude Code",
										copilot: "GitHub Copilot",
									}[provider],
								})}
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
					onChange={(event) => update({ spaceId: event.target.value || null })}
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
	);
}
