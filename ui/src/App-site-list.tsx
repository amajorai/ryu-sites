import { RyuAppEmpty } from "@ryu/blocks/companion/app-ui";
import { Badge, Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import {
	provenanceLabel,
	type RemixSource,
	SitesGallery,
	type SiteTemplate,
} from "./gallery.tsx";

export function SitesList({
	busy,
	duplicate,
	openSite,
	run,
	scope,
	search,
	setCreateOpen,
	setCreateTemplate,
	setRemixSource,
	setScope,
	setSearch,
	setSharingOpen,
	setSharingTarget,
	visibleSites,
}: {
	busy: boolean;
	duplicate: (item: RuntimeSite) => void;
	openSite: (next: RuntimeSite) => Promise<void>;
	run: (work: () => Promise<void>) => Promise<void>;
	scope: "owned" | "shared" | "gallery";
	search: string;
	setCreateOpen: (open: boolean) => void;
	setCreateTemplate: (template: SiteTemplate) => void;
	setRemixSource: (source: RemixSource | null) => void;
	setScope: (scope: "owned" | "shared" | "gallery") => void;
	setSearch: (search: string) => void;
	setSharingOpen: (open: boolean) => void;
	setSharingTarget: (target: string | null) => void;
	visibleSites: RuntimeSite[];
}) {
	const tl = useLiteralMessages();
	return (
		<>
			<div className="grid gap-4">
				<div className="flex items-end justify-between gap-3">
					<div>
						<h2 className="font-medium text-2xl">Sites</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							Create, refine, and publish websites.
						</p>
					</div>
					{scope === "gallery" ? null : (
						<Badge variant="outline">
							{tl("{count} sites", { count: String(visibleSites.length) })}
						</Badge>
					)}
				</div>
				{scope === "gallery" ? null : (
					<Input
						aria-label="Search sites"
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search sites"
						value={search}
					/>
				)}
				<div aria-label="Site ownership" className="flex gap-1" role="group">
					<Button
						aria-pressed={scope === "owned"}
						onClick={() => setScope("owned")}
						variant={scope === "owned" ? "secondary" : "ghost"}
					>
						Owned by you
					</Button>
					<Button
						aria-pressed={scope === "shared"}
						onClick={() => setScope("shared")}
						variant={scope === "shared" ? "secondary" : "ghost"}
					>
						Shared with you
					</Button>
					<Button
						aria-pressed={scope === "gallery"}
						onClick={() => setScope("gallery")}
						variant={scope === "gallery" ? "secondary" : "ghost"}
					>
						Gallery
					</Button>
				</div>
			</div>
			{scope === "gallery" ? (
				<SitesGallery
					busy={busy}
					onRemix={setRemixSource}
					onUseTemplate={(template) => {
						setCreateTemplate(template);
						setCreateOpen(true);
					}}
				/>
			) : visibleSites.length ? (
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					{visibleSites.map((item) => (
						<section className="rounded-lg border bg-card p-5" key={item.id}>
							<Badge variant="outline">
								{item.deploymentId ? "Deployed" : "Draft"} ·{" "}
								{item.settings.audience}
							</Badge>
							<h3 className="mt-4 font-medium text-lg">{item.name}</h3>
							<p className="mt-2 text-muted-foreground text-sm">
								{tl("{template} · {count} saved versions", {
									template: item.template,
									count: String(item.versions.length),
								})}
							</p>
							<p
								className="mt-2 truncate text-muted-foreground text-xs"
								title={item.slug}
							>
								{item.slug}
							</p>
							{item.remixedFrom ? (
								<p className="mt-1 truncate text-muted-foreground text-xs">
									{provenanceLabel(item)}
								</p>
							) : null}
							<div className="mt-5 flex flex-wrap gap-2">
								<Button
									disabled={busy}
									onClick={() => void run(() => openSite(item))}
									variant="outline"
								>
									Open site
								</Button>
								{item.access === "owner" ? (
									<>
										<Button
											disabled={busy}
											onClick={() => {
												setSharingTarget(item.id);
												setSharingOpen(true);
											}}
											variant="ghost"
										>
											Share
										</Button>
										<Button
											disabled={busy || item.versions.length === 0}
											onClick={() => duplicate(item)}
											variant="ghost"
										>
											Duplicate
										</Button>
									</>
								) : null}
							</div>
						</section>
					))}
				</div>
			) : (
				<RyuAppEmpty
					description={
						search.trim()
							? "Try another site name or URL."
							: scope === "shared"
								? "Sites shared with you appear here."
								: "Start with a help center, dashboard, game, or website. Every new site starts private."
					}
					title={search.trim() ? "No matching sites" : "No sites here"}
				/>
			)}
		</>
	);
}
