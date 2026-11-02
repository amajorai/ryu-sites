import {
	RyuAppEmpty,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Badge,
	Button,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
	Textarea,
} from "@ryu/blocks/companion/controls";
import { useI18n } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import {
	OWNER_CONNECTION_LIMIT,
	type OwnerConnection,
	ownerConnectionInput,
	type RuntimeSite,
} from "../../sidecar/src/contracts.ts";
import { projectPath, sitesRequest } from "./api.ts";
import {
	type OwnerConnectionsStatus,
	ownerConnectionsStatusSchema,
	runtimeSiteSchema,
} from "./schemas.ts";

interface Draft {
	agentId: string;
	description: string;
	id: string;
	label: string;
	readOnly: boolean;
	reconsent: boolean;
	toolId: string;
}
const emptyDraft: Draft = {
	agentId: "ryu",
	description: "",
	id: "",
	label: "",
	readOnly: true,
	reconsent: false,
	toolId: "",
};
const toRequest = (connection: OwnerConnection) => ({
	id: connection.id,
	label: connection.label,
	description: connection.description,
	toolId: connection.toolId,
	agentId: connection.agentId,
	readOnly: connection.readOnly,
});
/** Mirrors the sidecar's operator pattern match: exact IDs or `prefix*`. */
const matchesPattern = (patterns: readonly string[], value: string) =>
	patterns.some((pattern) =>
		pattern.endsWith("*")
			? value.startsWith(pattern.slice(0, -1))
			: value === pattern
	);
const errorMessage = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/**
 * Owner and editor managed connector bindings. Each binding names a Core
 * tool and its access; visitors run it with their own account after they
 * review and allow it, so sharing a Site never shares the owner's accounts.
 */
export function SiteConnectionsPanel({
	site,
	busy,
	run,
	replace,
}: {
	site: RuntimeSite;
	busy: boolean;
	run: (work: () => Promise<void>) => Promise<void>;
	replace: (site: RuntimeSite) => void;
}) {
	const { t } = useI18n();
	const [status, setStatus] = useState<OwnerConnectionsStatus | null>(null);
	const [loadError, setLoadError] = useState("");
	const [formError, setFormError] = useState("");
	const [notice, setNotice] = useState("");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const canManage = site.access === "owner" || site.access === "editor";

	useEffect(() => {
		let active = true;
		setLoadError("");
		sitesRequest(ownerConnectionsStatusSchema, projectPath(site, "connections"))
			.then((value) => {
				if (active) {
					setStatus(value);
				}
			})
			.catch((cause: unknown) => {
				if (active) {
					setStatus(null);
					setLoadError(errorMessage(cause, "Connections are unavailable"));
				}
			});
		return () => {
			active = false;
		};
	}, [site.id, site.revision, reload]);

	const current = status?.connections ?? [];
	const readOnlyAllowed = (toolId: string) =>
		matchesPattern(status?.policy.readOnlyTools ?? [], toolId);
	const draftReadOnly = Boolean(
		draft?.readOnly && readOnlyAllowed(draft.toolId)
	);
	const save = (next: ReturnType<typeof toRequest>[], message: string) =>
		run(async () => {
			setFormError("");
			try {
				replace(
					await sitesRequest(
						runtimeSiteSchema,
						projectPath(site, "connections"),
						"PUT",
						{ connections: next, expectedRevision: site.revision }
					)
				);
				setDraft(null);
				setEditing(null);
				setNotice(message);
			} catch (cause) {
				setFormError(errorMessage(cause, "Connections could not be saved"));
			}
		});
	const submit = () => {
		if (!draft) {
			return;
		}
		// Read access is only requested where the operator vouches for it;
		// the sidecar refuses anything else.
		const parsed = ownerConnectionInput.safeParse({
			...draft,
			readOnly: draftReadOnly,
		});
		if (!parsed.success) {
			setFormError(
				t(
					"sites.connections.invalid",
					undefined,
					"Use a lowercase ID, a label, and a Core tool ID such as slack.post_message."
				)
			);
			return;
		}
		if (!editing && current.some((entry) => entry.id === parsed.data.id)) {
			setFormError(
				t(
					"sites.connections.duplicate",
					undefined,
					"Another connection already uses this ID."
				)
			);
			return;
		}
		const next = editing
			? current.map((entry) =>
					entry.id === editing ? parsed.data : toRequest(entry)
				)
			: [...current.map(toRequest), parsed.data];
		void save(
			next,
			editing
				? t(
						"sites.connections.updated",
						undefined,
						"Connection updated. Visitors review it again when its access or wording changed."
					)
				: t(
						"sites.connections.added",
						undefined,
						"Connection added. Visitors review and allow it before first use."
					)
		);
	};
	const remove = (id: string) =>
		void save(
			current.filter((entry) => entry.id !== id).map(toRequest),
			t(
				"sites.connections.removed",
				undefined,
				"Connection removed. Visitor permissions for it were revoked."
			)
		);
	const startEdit = (connection: OwnerConnection) => {
		setEditing(connection.id);
		setFormError("");
		setDraft({ ...toRequest(connection), reconsent: false });
	};

	return (
		<RyuAppSection
			title={t("sites.connections.title", undefined, "Owner connections")}
		>
			<p className="text-muted-foreground text-sm">
				{t(
					"sites.connections.summary",
					undefined,
					"Let visitors use their own connected accounts, such as Slack, Notion, Google Drive or GitHub. Each visitor signs in, reviews the connection, and runs it as themselves. Your accounts are never shared."
				)}
			</p>
			{loadError ? (
				<div className="grid gap-2">
					<p className="text-destructive text-sm" role="alert">
						{loadError}
					</p>
					<Button
						className="justify-self-start"
						onClick={() => setReload((value) => value + 1)}
						variant="outline"
					>
						{t("sites.connections.retry", undefined, "Try again")}
					</Button>
				</div>
			) : null}
			{status || loadError ? null : (
				<p className="text-muted-foreground text-sm" role="status">
					{t("sites.connections.loading", undefined, "Loading connections…")}
				</p>
			)}
			{status && !status.policy.enabled ? (
				<RyuAppEmpty
					description={t(
						"sites.connections.disabled.description",
						undefined,
						"Your Ryu operator has turned off owner connections. Existing ones are hidden from visitors; you can still remove them."
					)}
					title={t(
						"sites.connections.disabled",
						undefined,
						"Owner connections are off"
					)}
				/>
			) : null}
			{status && !status.available ? (
				<p className="text-muted-foreground text-sm">
					{t(
						"sites.connections.unavailable",
						undefined,
						"Connected tools need platform sign-in for visitors. Ask your operator to configure Site identity."
					)}
				</p>
			) : null}
			{status?.policy.tools ? (
				<p className="text-muted-foreground text-sm">
					{t(
						"sites.connections.allowlist",
						undefined,
						"Your operator allows these tools:"
					)}{" "}
					<span className="font-mono">{status.policy.tools.join(", ")}</span>
				</p>
			) : null}
			{status && current.length === 0 && status.policy.enabled ? (
				<RyuAppEmpty
					description={t(
						"sites.connections.empty.description",
						undefined,
						"Add a tool your visitors can run with their own account."
					)}
					title={t(
						"sites.connections.empty",
						undefined,
						"No owner connections"
					)}
				/>
			) : null}
			{current.map((connection) => (
				<div
					className="flex items-start justify-between gap-3 rounded-lg border p-3"
					key={connection.id}
				>
					<div className="grid min-w-0 gap-1">
						<p
							className="truncate font-medium text-sm"
							title={connection.label}
						>
							{connection.label}
						</p>
						<p
							className="truncate font-mono text-muted-foreground text-xs"
							title={connection.toolId}
						>
							{connection.toolId}
						</p>
						{connection.description ? (
							<p className="text-muted-foreground text-sm">
								{connection.description}
							</p>
						) : null}
						<div className="flex flex-wrap gap-2">
							<Badge variant="outline">
								{(connection.effectiveReadOnly ?? connection.readOnly)
									? t("sites.connections.read", undefined, "Read access")
									: t(
											"sites.connections.write",
											undefined,
											"Read and write access"
										)}
							</Badge>
							{connection.allowed ? null : (
								<Badge variant="destructive">
									{t(
										"sites.connections.blocked",
										undefined,
										"Blocked by operator policy"
									)}
								</Badge>
							)}
						</div>
					</div>
					{canManage ? (
						<div className="flex shrink-0 gap-2">
							<Button
								aria-label={`${t("sites.connections.edit", undefined, "Edit")} ${connection.label}`}
								disabled={busy}
								onClick={() => startEdit(connection)}
								variant="ghost"
							>
								{t("sites.connections.edit", undefined, "Edit")}
							</Button>
							<Button
								aria-label={`${t("sites.connections.remove", undefined, "Remove")} ${connection.label}`}
								disabled={busy}
								onClick={() => remove(connection.id)}
								variant="ghost"
							>
								{t("sites.connections.remove", undefined, "Remove")}
							</Button>
						</div>
					) : null}
				</div>
			))}
			{draft ? (
				<div className="grid gap-3 rounded-lg border p-4">
					<RyuAppField label={t("sites.connections.id", undefined, "ID")}>
						<Input
							aria-label={t("sites.connections.id", undefined, "ID")}
							disabled={Boolean(editing)}
							onChange={(event) =>
								setDraft({ ...draft, id: event.target.value })
							}
							placeholder="team_slack"
							value={draft.id}
						/>
					</RyuAppField>
					<RyuAppField label={t("sites.connections.label", undefined, "Label")}>
						<Input
							aria-label={t("sites.connections.label", undefined, "Label")}
							onChange={(event) =>
								setDraft({ ...draft, label: event.target.value })
							}
							value={draft.label}
						/>
					</RyuAppField>
					<RyuAppField
						label={t(
							"sites.connections.description",
							undefined,
							"Shown to visitors when they review it"
						)}
					>
						<Textarea
							aria-label={t(
								"sites.connections.description.label",
								undefined,
								"Connection description"
							)}
							maxLength={300}
							onChange={(event) =>
								setDraft({ ...draft, description: event.target.value })
							}
							value={draft.description}
						/>
					</RyuAppField>
					<RyuAppField
						label={t("sites.connections.tool", undefined, "Core tool ID")}
					>
						<Input
							aria-label={t(
								"sites.connections.tool",
								undefined,
								"Core tool ID"
							)}
							onChange={(event) =>
								setDraft({ ...draft, toolId: event.target.value.trim() })
							}
							placeholder="slack.post_message"
							value={draft.toolId}
						/>
					</RyuAppField>
					<p className="text-muted-foreground text-xs">
						{t(
							"sites.connections.tool.help",
							undefined,
							"Ryu checks the tool, the visitor's agent permission and their connected account each time a visitor runs it."
						)}
					</p>
					<RyuAppField
						label={t("sites.connections.access", undefined, "Access")}
					>
						<Select
							onValueChange={(value) =>
								setDraft({ ...draft, readOnly: value === "read" })
							}
							value={draftReadOnly ? "read" : "write"}
						>
							<SelectTrigger
								aria-label={t("sites.connections.access", undefined, "Access")}
							>
								<SelectValue>
									{draftReadOnly
										? t("sites.connections.read", undefined, "Read access")
										: t(
												"sites.connections.write",
												undefined,
												"Read and write access"
											)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem
									disabled={!readOnlyAllowed(draft.toolId)}
									value="read"
								>
									{t("sites.connections.read", undefined, "Read access")}
								</SelectItem>
								<SelectItem value="write">
									{t(
										"sites.connections.write",
										undefined,
										"Read and write access"
									)}
								</SelectItem>
							</SelectContent>
						</Select>
					</RyuAppField>
					{readOnlyAllowed(draft.toolId) ? null : (
						<p className="text-muted-foreground text-xs">
							{t(
								"sites.connections.access.write_only",
								undefined,
								"Your operator has not confirmed this tool is read-only, so it gets read and write access and visitors confirm each call."
							)}
						</p>
					)}
					{editing ? (
						<div className="flex items-center justify-between gap-4">
							<label className="text-sm" htmlFor="connection-reconsent">
								{t(
									"sites.connections.reconsent",
									undefined,
									"Ask every visitor to allow it again"
								)}
							</label>
							<Switch
								checked={draft.reconsent}
								id="connection-reconsent"
								onCheckedChange={(reconsent) =>
									setDraft({ ...draft, reconsent })
								}
							/>
						</div>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button disabled={busy} onClick={submit}>
							{editing
								? t("sites.connections.save", undefined, "Save connection")
								: t("sites.connections.add", undefined, "Add connection")}
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								setDraft(null);
								setEditing(null);
								setFormError("");
							}}
							variant="outline"
						>
							{t("sites.connections.cancel", undefined, "Cancel")}
						</Button>
					</div>
				</div>
			) : null}
			{canManage &&
			status?.policy.enabled &&
			status.available &&
			!draft &&
			current.length < OWNER_CONNECTION_LIMIT ? (
				<Button
					className="justify-self-start"
					disabled={busy}
					onClick={() => {
						setEditing(null);
						setFormError("");
						setDraft(emptyDraft);
					}}
					variant="outline"
				>
					{t("sites.connections.new", undefined, "Add a connection")}
				</Button>
			) : null}
			{formError ? (
				<p className="text-destructive text-sm" role="alert">
					{formError}
				</p>
			) : null}
			{notice ? (
				<p className="text-sm" role="status">
					{notice}
				</p>
			) : null}
			{status?.operator.length ? (
				<div className="grid gap-2">
					<p className="font-medium text-sm">
						{t(
							"sites.connections.operator",
							undefined,
							"Operator-approved connections"
						)}
					</p>
					{status.operator.map((connection) => (
						<div
							className="flex items-center justify-between gap-3 text-sm"
							key={connection.id}
						>
							<span className="truncate" title={connection.label}>
								{connection.label}
							</span>
							<Badge variant="outline">
								{connection.selected
									? t("sites.connections.selected", undefined, "Selected")
									: t(
											"sites.connections.not.selected",
											undefined,
											"Not selected"
										)}
							</Badge>
						</div>
					))}
				</div>
			) : null}
		</RyuAppSection>
	);
}
