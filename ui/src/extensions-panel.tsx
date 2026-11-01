import {
	RyuAppEmpty,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Badge,
	Button,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
} from "@ryu/blocks/companion/controls";
import { useI18n, useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import { siteDataValueSchema } from "../../sidecar/src/data-values.ts";
import { siteTool } from "../../sidecar/src/extensions.ts";
import { projectPath, sitesRequest } from "./api.ts";
import type { ExtensionStatus } from "./schemas.ts";
import { extensionStatusSchema, runtimeSiteSchema } from "./schemas.ts";
import type { ServiceStatus } from "./settings.tsx";

export function SiteExtensionsPanel({
	site,
	status,
	busy,
	run,
	replace,
}: {
	site: RuntimeSite;
	status: ServiceStatus;
	busy: boolean;
	run: (work: () => Promise<void>) => Promise<void>;
	replace: (site: RuntimeSite) => void;
}) {
	const { t } = useI18n();
	const tl = useLiteralMessages();
	const operationLabels = {
		"records.list": t(
			"sites.extensions.list.records",
			undefined,
			"List records"
		),
		"records.set": t(
			"sites.extensions.save.record",
			undefined,
			"Save a record"
		),
		"records.delete": t(
			"sites.extensions.delete.record",
			undefined,
			"Delete a record"
		),
		"knowledge.search": t(
			"sites.extensions.search.knowledge",
			undefined,
			"Search knowledge"
		),
	};
	const [config, setConfig] = useState(site.settings.extensions);
	const [service, setService] = useState<ExtensionStatus | null>(null);
	const [error, setError] = useState("");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [collection, setCollection] = useState("data");
	const [operation, setOperation] =
		useState<keyof typeof operationLabels>("records.list");
	const [notice, setNotice] = useState("");
	const [installed, setInstalled] = useState(false);
	const [addingTool, setAddingTool] = useState(
		site.settings.extensions.tools.length === 0
	);
	useEffect(() => {
		let active = true;
		sitesRequest(extensionStatusSchema, projectPath(site, "extensions"))
			.then((value) => {
				if (active) {
					setService(value);
				}
			})
			.catch((cause: unknown) => {
				if (active) {
					setError(
						cause instanceof Error ? cause.message : "Extensions unavailable"
					);
				}
			});
		return () => {
			active = false;
		};
	}, [site.id, site.revision]);
	const owner = site.access === "owner";
	const add = () => {
		const result = siteTool.safeParse({
			name,
			description,
			operation,
			collection,
		});
		if (!result.success || config.tools.some((tool) => tool.name === name)) {
			setError(
				"Use a unique tool name, a description, and a valid collection."
			);
			return;
		}
		setConfig((current) => ({
			...current,
			tools: [...current.tools, result.data],
		}));
		setName("");
		setDescription("");
		setError("");
		setAddingTool(false);
	};
	return (
		<div className="grid gap-8 lg:grid-cols-2">
			<RyuAppSection
				title={t(
					"sites.extensions.site.mcp.plugin",
					undefined,
					"Site MCP plugin"
				)}
			>
				<p className="text-muted-foreground text-sm">
					Expose selected Site operations to agents. Each user connects with
					their own Site access.
				</p>
				<div className="flex items-center justify-between gap-4">
					<Label htmlFor="site-mcp">
						{t(
							"sites.extensions.enable.mcp.tools",
							undefined,
							"Enable MCP tools"
						)}
					</Label>
					<Switch
						checked={config.mcp}
						disabled={!owner || busy || !status.mcpAvailable}
						id="site-mcp"
						onCheckedChange={(mcp) =>
							setConfig((current) => ({ ...current, mcp }))
						}
					/>
				</div>
				{status.mcpAvailable ? null : (
					<p className="text-muted-foreground text-sm">
						Platform MCP authentication is unavailable.
					</p>
				)}
				<div className="flex items-center justify-between gap-4">
					<Label htmlFor="site-mcp-ui">Show Site UI in chat</Label>
					<Switch
						checked={config.ui}
						disabled={!owner || busy || !status.mcpUiAvailable}
						id="site-mcp-ui"
						onCheckedChange={(ui) =>
							setConfig((current) => ({ ...current, ui }))
						}
					/>
				</div>
				{config.tools.map((tool) => (
					<div
						className="flex items-center justify-between gap-3 rounded-lg border p-3"
						key={tool.name}
					>
						<div className="min-w-0">
							<p className="truncate font-medium text-sm" title={tool.name}>
								{tool.name}
							</p>
							<p className="text-muted-foreground text-xs">
								{operationLabels[tool.operation]} · {tool.collection}
							</p>
							<p className="text-muted-foreground text-sm">
								{tool.description}
							</p>
						</div>
						<Button
							aria-label={tl("Remove {toolName}", { toolName: tool.name })}
							disabled={!owner || busy}
							onClick={() =>
								setConfig((current) => ({
									...current,
									tools: current.tools.filter(
										(item) => item.name !== tool.name
									),
								}))
							}
							variant="ghost"
						>
							Remove
						</Button>
					</div>
				))}
				{owner && addingTool ? (
					<div className="grid gap-3">
						<RyuAppField
							label={t("sites.extensions.tool.name", undefined, "Tool name")}
						>
							<Input
								aria-label={t(
									"sites.extensions.tool.name",
									undefined,
									"Tool name"
								)}
								onChange={(event) => setName(event.target.value)}
								placeholder={t(
									"sites.extensions.list.todos",
									undefined,
									"list_todos"
								)}
								value={name}
							/>
						</RyuAppField>
						<RyuAppField
							label={t(
								"sites.extensions.tool.description",
								undefined,
								"Tool description"
							)}
						>
							<Input
								aria-label={t(
									"sites.extensions.tool.description",
									undefined,
									"Tool description"
								)}
								onChange={(event) => setDescription(event.target.value)}
								value={description}
							/>
						</RyuAppField>
						<RyuAppField
							label={t("sites.extensions.operation", undefined, "Operation")}
						>
							<Select
								onValueChange={(value) =>
									setOperation(siteTool.shape.operation.parse(value))
								}
								value={operation}
							>
								<SelectTrigger
									aria-label={t(
										"sites.extensions.tool.operation",
										undefined,
										"Tool operation"
									)}
								>
									<SelectValue>{operationLabels[operation]}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="records.list">
										{t(
											"sites.extensions.list.records",
											undefined,
											"List records"
										)}
									</SelectItem>
									<SelectItem value="records.set">
										{t(
											"sites.extensions.save.a.record",
											undefined,
											"Save a record"
										)}
									</SelectItem>
									<SelectItem value="records.delete">
										Delete a record
									</SelectItem>
									<SelectItem value="knowledge.search">
										Search knowledge
									</SelectItem>
								</SelectContent>
							</Select>
						</RyuAppField>
						<RyuAppField
							label={t("sites.extensions.collection", undefined, "Collection")}
						>
							<Input
								aria-label={t(
									"sites.extensions.tool.collection",
									undefined,
									"Tool collection"
								)}
								onChange={(event) => setCollection(event.target.value)}
								value={collection}
							/>
						</RyuAppField>
						<Button
							disabled={busy || config.tools.length >= 20}
							onClick={add}
							variant="outline"
						>
							Add tool
						</Button>
					</div>
				) : null}
				{owner && !addingTool ? (
					<Button
						disabled={busy}
						onClick={() => setAddingTool(true)}
						variant="outline"
					>
						{t(
							"sites.extensions.add.another.tool",
							undefined,
							"Add another tool"
						)}
					</Button>
				) : null}
				{service?.published.mcp && site.deploymentId ? (
					<div className="grid gap-3 rounded-lg border p-4">
						<Badge variant="outline">
							{t(
								"sites.extensions.published.mcp.plugin",
								undefined,
								"Published MCP plugin"
							)}
						</Badge>
						<Input
							aria-label={t(
								"sites.extensions.mcp.endpoint",
								undefined,
								"MCP endpoint"
							)}
							readOnly
							value={service.plugin.mcp_servers.site.url}
						/>
						<p className="text-muted-foreground text-sm">
							Install the plugin on this Ryu node, then review and connect it in
							Plugins.
						</p>
						<Button
							onClick={() =>
								void run(async () => {
									await navigator.clipboard.writeText(
										JSON.stringify(service.plugin, null, 2)
									);
									setNotice("Native plugin manifest copied.");
								})
							}
							variant="outline"
						>
							Copy native manifest
						</Button>
					</div>
				) : (
					<p className="text-muted-foreground text-sm">
						Save extensions, save a new version, then deploy it to publish the
						plugin.
					</p>
				)}
				{service?.published.mcp && status.pluginInstallAvailable ? (
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={busy || !owner || installed}
							onClick={() =>
								void run(async () => {
									await sitesRequest(
										siteDataValueSchema,
										projectPath(site, "install-plugin"),
										"POST",
										{ expectedRevision: site.revision }
									);
									setInstalled(true);
									setNotice(
										"Plugin installed. Review and enable it in Plugins, then connect your account."
									);
								})
							}
						>
							{installed ? "Plugin installed" : "Install plugin"}
						</Button>
						<Button
							disabled={busy || !owner}
							onClick={() =>
								void run(async () => {
									await sitesRequest(
										siteDataValueSchema,
										projectPath(site, "install-plugin"),
										"POST",
										{ expectedRevision: site.revision, update: true }
									);
									setNotice(
										"Installed plugin updated. Review its connection in Plugins."
									);
								})
							}
							variant="outline"
						>
							{t(
								"sites.extensions.update.installed.plugin",
								undefined,
								"Update installed plugin"
							)}
						</Button>
					</div>
				) : null}
			</RyuAppSection>
			<RyuAppSection
				title={t(
					"sites.extensions.visitor.connections",
					undefined,
					"Visitor connections"
				)}
			>
				<p className="text-muted-foreground text-sm">
					Choose operator-approved tools. Visitors must sign in to the Site
					workspace and allow each connection. Background jobs cannot reuse
					visitor consent.
				</p>
				{service ? (
					service.connections.length ? (
						service.connections.map((connection) => (
							<div
								className="flex items-center justify-between gap-3 rounded-lg border p-3"
								key={connection.id}
							>
								<div>
									<Label htmlFor={`connection-${connection.id}`}>
										{connection.label}
									</Label>
									<p className="text-muted-foreground text-xs">
										{connection.readOnly
											? "Read access"
											: "Read and write access"}
									</p>
								</div>
								<Switch
									checked={config.connections.includes(connection.id)}
									disabled={!owner || busy || !status.connectionsAvailable}
									id={`connection-${connection.id}`}
									onCheckedChange={(enabled) =>
										setConfig((current) => ({
											...current,
											connections: enabled
												? [...current.connections, connection.id]
												: current.connections.filter(
														(id) => id !== connection.id
													),
										}))
									}
								/>
							</div>
						))
					) : (
						<RyuAppEmpty
							description="Your operator can approve specific plugin or MCP tools for this Site."
							title={t(
								"sites.extensions.no.approved.connections",
								undefined,
								"No approved connections"
							)}
						/>
					)
				) : (
					<p role="status">Loading connections…</p>
				)}
				{error ? (
					<p className="text-destructive text-sm" role="alert">
						{error}
					</p>
				) : null}
				{notice ? (
					<p className="text-sm" role="status">
						{notice}
					</p>
				) : null}
				<Button
					disabled={!owner || busy || !service}
					onClick={() =>
						void run(async () => {
							replace(
								await sitesRequest(
									runtimeSiteSchema,
									projectPath(site, "extensions"),
									"PUT",
									{ extensions: config, expectedRevision: site.revision }
								)
							);
							setNotice(
								"Extensions saved. Save and deploy a new version to activate them."
							);
						})
					}
				>
					Save extensions
				</Button>
			</RyuAppSection>
		</div>
	);
}
