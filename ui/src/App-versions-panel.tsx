import { RyuAppEmpty, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import type { Panel } from "./App-panel.ts";
import { projectPath, sitesRequest } from "./api.ts";
import { artifactSchema, runtimeSiteSchema } from "./schemas.ts";
import type { ServiceStatus } from "./settings.tsx";

export function SiteVersionsPanel({
	busy,
	replace,
	run,
	setHtml,
	setNotice,
	setPanel,
	site,
	status,
}: {
	busy: boolean;
	replace: (next: RuntimeSite) => void;
	run: (work: () => Promise<void>) => Promise<void>;
	setHtml: (html: string) => void;
	setNotice: (notice: string) => void;
	setPanel: (panel: Panel) => void;
	site: RuntimeSite;
	status: ServiceStatus | null;
}) {
	const tl = useLiteralMessages();
	return (
		<RyuAppSection title="Saved versions">
			<p className="text-muted-foreground text-sm">
				Saving keeps an immutable build. Deploying makes that build available to
				the selected audience.
			</p>
			{site.versions.length ? (
				[...site.versions].reverse().map((version, index) => (
					<div
						className="flex flex-wrap items-center justify-between gap-3 border-b py-4"
						key={version.id}
					>
						<div>
							<p className="font-medium">
								{tl("Version {number} {deployed}", {
									number: String(site.versions.length - index),
									deployed:
										site.deploymentId === version.id ? tl("· Deployed") : "",
								})}
							</p>
							<p className="mt-1 text-muted-foreground text-sm">
								{version.message || "Saved version"}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{formatDateTime(version.createdAt)} ·{" "}
								{Math.ceil(version.bytes / 1024)} KB
							</p>
						</div>
						<div className="flex gap-2">
							<Button
								disabled={busy}
								onClick={() =>
									void run(async () => {
										const artifact = await sitesRequest(
											artifactSchema,
											projectPath(site, `versions/${version.id}`)
										);
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
											await sitesRequest(
												runtimeSiteSchema,
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
						href={
							status.baseDomain === "localhost"
								? `http://${site.slug}.localhost:${status.visitorPort}/`
								: `https://${site.slug}.${status.baseDomain}/`
						}
						rel="noopener noreferrer"
						target="_blank"
					>
						{site.slug}.{status.baseDomain}
						{status.baseDomain === "localhost" ? `:${status.visitorPort}` : ""}
					</a>
				</p>
			) : null}
		</RyuAppSection>
	);
}
