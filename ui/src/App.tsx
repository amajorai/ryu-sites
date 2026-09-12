import {
	RyuAppEmpty,
	RyuAppMain,
	RyuAppSection,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui";
import {
	Badge,
	Button,
	Input,
	Label,
	Textarea,
} from "@ryu/blocks/companion/controls";
import { useCallback, useEffect, useState } from "react";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import { previewDocument } from "../../sidecar/src/preview.ts";
import { starterHtml } from "../../sidecar/src/templates.ts";
import { projectPath, sitesRequest } from "./api.ts";
import { SiteSecurityPanel } from "./security.tsx";
import {
	Analytics,
	CreateSiteDialog,
	type ServiceStatus,
	SiteSettingsPanel,
} from "./settings.tsx";

type Panel =
	| "preview"
	| "source"
	| "versions"
	| "security"
	| "settings"
	| "analytics";
const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "The operation failed";
export function SitesApp() {
	const [sites, setSites] = useState<RuntimeSite[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [status, setStatus] = useState<ServiceStatus | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [createOpen, setCreateOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [html, setHtml] = useState("");
	const [runtime, setRuntime] = useState("");
	const [panel, setPanel] = useState<Panel>("preview");
	const [mobile, setMobile] = useState(false);
	const site = sites.find((candidate) => candidate.id === selected) ?? null;
	const replace = useCallback(
		(next: RuntimeSite) =>
			setSites((current) =>
				current.map((item) => (item.id === next.id ? next : item))
			),
		[]
	);
	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await work();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const reload = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const [projects, service, script] = await Promise.all([
				sitesRequest<RuntimeSite[]>("/projects"),
				sitesRequest<ServiceStatus>("/status"),
				sitesRequest<{ script: string }>("/runtime"),
			]);
			setSites(projects);
			setStatus(service);
			setRuntime(script.script);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);
	const openSite = async (next: RuntimeSite) => {
		setSelected(next.id);
		setPanel("preview");
		setPrompt(next.prompt);
		setHtml("");
		const version = next.versions.at(-1);
		if (version) {
			const result = await sitesRequest<{ html: string }>(
				projectPath(next, `versions/${version.id}`)
			);
			setHtml(result.html);
		} else {
			setHtml(starterHtml(next.name, next.template, next.prompt));
		}
	};
	const save = () =>
		site &&
		run(async () => {
			replace(
				await sitesRequest<RuntimeSite>(projectPath(site, "versions"), "POST", {
					html,
					message: prompt.slice(0, 500) || "Saved from Sites",
					expectedRevision: site.revision,
				})
			);
			setNotice("Version saved. The deployed version has not changed.");
			setPanel("versions");
		});
	const generate = () =>
		site &&
		run(async () => {
			if (!window.ryu?.model?.complete) {
				throw new Error(
					"Connect a Ryu model to generate or refine this site. You can still edit source or import an HTML build."
				);
			}
			const result = await window.ryu.model.complete({
				prompt: `${prompt}\n\nCurrent HTML:\n${html}`,
				system:
					"Build or refine a self-contained accessible website. Return only HTML beginning with <!doctype html>. Use inline CSS and JS, no external network, eval, dependencies or secrets. Preserve existing features unless asked to change. RyuSite is available from /_ryu/runtime.js: local(namespace) provides async get/set/delete/keys; search(documents,query) returns id/title/excerpt/score. Browser data is local; never silently upload it. Server capabilities must handle denial. Never claim a form sent data unless it did.",
			});
			const output = result
				.trim()
				.replace(/^```(?:html)?\s*/i, "")
				.replace(/\s*```$/, "");
			if (!/^<!doctype html/i.test(output) || output.length > 2_000_000) {
				throw new Error(
					"The model did not return a compatible HTML build. Refine the request and try again."
				);
			}
			setHtml(output);
			setPanel("preview");
			setNotice(
				"Generated changes are ready to review. Save a version to keep them."
			);
		});
	const preview = previewDocument(html, runtime);
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="sites-app">
			<RyuAppToolbar
				actions={
					site ? (
						<>
							<Button
								onClick={() => {
									setSelected(null);
									setHtml("");
								}}
								variant="ghost"
							>
								All sites
							</Button>
							<Button disabled={busy || !html} onClick={() => void save()}>
								Save version
							</Button>
						</>
					) : (
						<Button
							disabled={busy || !status}
							onClick={() => setCreateOpen(true)}
						>
							New site
						</Button>
					)
				}
				title={site ? site.name : "Sites"}
			/>
			<RyuAppMain>
				{error ? (
					<div
						className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 p-3 text-sm"
						role="alert"
					>
						<span>{error}</span>
						<Button
							disabled={busy}
							onClick={() => void reload()}
							variant="outline"
						>
							Reload
						</Button>
					</div>
				) : null}
				{notice ? (
					<p className="text-sm text-status-success" role="status">
						{notice}
					</p>
				) : null}
				{loading ? (
					<p role="status">Connecting to Sites…</p>
				) : site ? (
					<>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex gap-2">
								<Badge variant="outline">{site.settings.audience}</Badge>
								<Badge variant="secondary">
									{site.settings.mode === "local"
										? "Browser-local"
										: "Connected"}
								</Badge>
								<Badge variant="outline">
									{site.deploymentId ? "Deployed" : "Not deployed"}
								</Badge>
							</div>
							<div aria-label="Site sections" className="flex flex-wrap gap-1">
								{(
									[
										"preview",
										"source",
										"versions",
										"security",
										"settings",
										"analytics",
									] as Panel[]
								).map((item) => (
									<Button
										aria-pressed={panel === item}
										key={item}
										onClick={() => setPanel(item)}
										variant={panel === item ? "secondary" : "ghost"}
									>
										{item.charAt(0).toUpperCase() + item.slice(1)}
									</Button>
								))}
							</div>
						</div>
						{panel === "preview" || panel === "source" ? (
							<div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
								<RyuAppSection title="Describe your website">
									<Label htmlFor="site-prompt">What should change?</Label>
									<Textarea
										className="min-h-40"
										id="site-prompt"
										maxLength={12_000}
										onChange={(event) => setPrompt(event.target.value)}
										placeholder="Add the features, audience, and style you want…"
										value={prompt}
									/>
									<Button
										disabled={busy || !prompt.trim()}
										onClick={() => void generate()}
									>
										{busy ? "Working…" : "Generate changes"}
									</Button>
									<p className="text-muted-foreground text-xs">
										Uses your Ryu model. Review before saving and deploying.
									</p>
									<Label htmlFor="import-site">Import an HTML build</Label>
									<Input
										accept=".html,text/html"
										disabled={busy}
										id="import-site"
										onChange={(event) => {
											const file = event.target.files?.[0];
											if (file) {
												void run(async () => {
													if (file.size > 2_000_000) {
														throw new Error("Build must be under 2 MB");
													}
													const text = await file.text();
													if (!/^\s*<!doctype html/i.test(text)) {
														throw new Error("Choose a complete HTML build");
													}
													setHtml(text);
													setNotice(
														"Imported for review. Save a version to keep it."
													);
												});
											}
										}}
										type="file"
									/>
									<p className="text-muted-foreground text-xs">
										Build your project first. Package scripts are not executed
										during import.
									</p>
								</RyuAppSection>
								<section className="flex min-w-0 flex-col gap-2">
									{panel === "source" ? (
										<>
											<Label htmlFor="site-html">HTML source</Label>
											<Textarea
												className="min-h-[560px] font-mono text-xs"
												id="site-html"
												onChange={(event) => setHtml(event.target.value)}
												value={html}
											/>
										</>
									) : (
										<>
											<div className="flex justify-between gap-2">
												<p className="text-muted-foreground text-xs">
													Sandbox preview · storage works on the deployed site
												</p>
												<Button
													aria-pressed={mobile}
													onClick={() => setMobile((value) => !value)}
													size="sm"
													variant="outline"
												>
													{mobile ? "Desktop width" : "Mobile width"}
												</Button>
											</div>
											<iframe
												className="mx-auto min-h-[600px] w-full rounded-lg border bg-white"
												sandbox="allow-scripts"
												srcDoc={preview}
												style={{ maxWidth: mobile ? 390 : undefined }}
												title="Website preview"
											/>
										</>
									)}
								</section>
							</div>
						) : null}
						{panel === "versions" ? (
							<RyuAppSection title="Saved versions">
								<p className="text-muted-foreground text-sm">
									Saving keeps an immutable build. Deploying makes that build
									available to the selected audience.
								</p>
								{site.versions.length ? (
									[...site.versions].reverse().map((version, index) => (
										<div
											className="flex flex-wrap items-center justify-between gap-3 border-b py-4"
											key={version.id}
										>
											<div>
												<p className="font-medium">
													Version {site.versions.length - index}{" "}
													{site.deploymentId === version.id ? "· Deployed" : ""}
												</p>
												<p className="mt-1 text-muted-foreground text-sm">
													{version.message || "Saved version"}
												</p>
												<p className="mt-1 text-muted-foreground text-xs">
													{new Date(version.createdAt).toLocaleString()} ·{" "}
													{Math.ceil(version.bytes / 1024)} KB
												</p>
											</div>
											<div className="flex gap-2">
												<Button
													disabled={busy}
													onClick={() =>
														void run(async () => {
															const artifact = await sitesRequest<{
																html: string;
															}>(projectPath(site, `versions/${version.id}`));
															setHtml(artifact.html);
															setPanel("preview");
														})
													}
													variant="outline"
												>
													Review
												</Button>
												<Button
													disabled={busy || site.deploymentId === version.id}
													onClick={() =>
														void run(async () => {
															replace(
																await sitesRequest<RuntimeSite>(
																	projectPath(site, "deploy"),
																	"POST",
																	{
																		versionId: version.id,
																		expectedRevision: site.revision,
																	}
																)
															);
															setNotice(
																"Deployment selected. Access follows this Site’s sharing settings."
															);
														})
													}
												>
													Deploy version
												</Button>
											</div>
										</div>
									))
								) : (
									<RyuAppEmpty
										description="Review your site, then save a version."
										title="No saved versions"
									/>
								)}
								{site.deploymentId && status ? (
									<p className="break-all text-sm">
										Visitor URL:{" "}
										<a
											href={status.baseDomain === "localhost" ? `http://${site.slug}.localhost:${status.visitorPort}/` : `https://${site.slug}.${status.baseDomain}/`}
											rel="noopener noreferrer"
											target="_blank"
										>
											{site.slug}.{status.baseDomain}{status.baseDomain === "localhost" ? `:${status.visitorPort}` : ""}
										</a>
									</p>
								) : null}
							</RyuAppSection>
						) : null}
						{panel === "settings" && status ? (
							<SiteSettingsPanel
								busy={busy}
								key={`${site.id}:${site.revision}`}
								onDelete={() => {
									setSites((current) =>
										current.filter((item) => item.id !== site.id)
									);
									setSelected(null);
								}}
								replace={replace}
								run={run}
								site={site}
								status={status}
							/>
						) : null}
						{panel === "analytics" ? <Analytics site={site} /> : null}
						{panel === "security" ? <SiteSecurityPanel site={site} /> : null}
					</>
				) : (
					<>
						<div className="flex items-center justify-between gap-3">
							<div>
								<h2 className="font-medium text-xl">
									Your websites, ready to grow.
								</h2>
								<p className="mt-2 text-muted-foreground text-sm">
									Create, refine, save, and deploy. Data and access stay under
									your control.
								</p>
							</div>
							<Badge variant="outline">{sites.length} sites</Badge>
						</div>
						{sites.length ? (
							<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
								{sites.map((item) => (
									<section
										className="rounded-lg border bg-card p-5"
										key={item.id}
									>
										<Badge variant="outline">
											{item.deploymentId ? "Deployed" : "Draft"} ·{" "}
											{item.settings.audience}
										</Badge>
										<h3 className="mt-4 font-medium text-lg">{item.name}</h3>
										<p className="mt-2 text-muted-foreground text-sm">
											{item.template} · {item.versions.length} saved versions
										</p>
										<p className="mt-2 truncate text-muted-foreground text-xs">
											{item.slug}
										</p>
										<Button
											className="mt-5"
											disabled={busy}
											onClick={() => void run(() => openSite(item))}
											variant="outline"
										>
											Open site
										</Button>
									</section>
								))}
							</div>
						) : (
							<RyuAppEmpty
								description="Start with a help center, dashboard, game, or website. Every new site starts private."
								title="Build your first site"
							/>
						)}
					</>
				)}
			</RyuAppMain>
			<CreateSiteDialog
				busy={busy}
				onCreate={async (next) => {
					setSites((current) => [next, ...current]);
					setCreateOpen(false);
					await openSite(next);
				}}
				open={createOpen}
				run={run}
				setOpen={setCreateOpen}
			/>
		</div>
	);
}
