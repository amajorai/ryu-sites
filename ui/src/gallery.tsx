import { RyuAppEmpty, RyuAppField } from "@ryu/blocks/companion/app-ui";
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
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import { useCallback, useEffect, useState } from "react";
import type {
	RemixableSite,
	RuntimeSite,
} from "../../sidecar/src/contracts.ts";
import { starterHtml } from "../../sidecar/src/templates.ts";
import { sitesRequest } from "./api.ts";
import { remixableSitesSchema, runtimeSiteSchema } from "./schemas.ts";

type Run = (work: () => Promise<void>) => Promise<void>;
export type SiteTemplate = RuntimeSite["template"];

/** The built-in starters, in the order the Gallery shows them. */
export const SITE_TEMPLATES: readonly {
	description: string;
	id: SiteTemplate;
	name: string;
}[] = [
	{
		id: "help-center",
		name: "Help center",
		description:
			"Searchable articles with optional answers from a connected knowledge Space.",
	},
	{
		id: "website",
		name: "Website",
		description: "A simple page to introduce an idea, product or project.",
	},
	{
		id: "dashboard",
		name: "Request tracker",
		description: "Collect and list requests, saved in the visitor's browser.",
	},
	{
		id: "game",
		name: "Number game",
		description: "A small guessing game that runs entirely in the page.",
	},
	{
		id: "reset-calendar",
		name: "Reset calendar",
		description: "Track usage resets with optional owner reset checks.",
	},
];

/** A URL name from a display name, in the form the sidecar accepts. */
export function slugFrom(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^[^a-z]+|-$/g, "")
		.slice(0, 48)
		.replace(/-$/, "");
}

/** What a Remix or Duplicate request copies from. */
export interface RemixSource {
	id: string;
	kind: "duplicate" | "remix";
	name: string;
}

/**
 * Names the new private Site for a remix or duplicate. The sidecar decides
 * what is copied and refuses Sites the caller may not remix.
 */
export function RemixSiteDialog({
	busy,
	onCreated,
	onOpenChange,
	run,
	source,
}: {
	busy: boolean;
	onCreated: (site: RuntimeSite) => Promise<void>;
	onOpenChange: (open: boolean) => void;
	run: Run;
	source: RemixSource | null;
}) {
	const tl = useLiteralMessages();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [dialogError, setDialogError] = useState("");
	useEffect(() => {
		if (source) {
			const suggested = `${source.name} ${source.kind === "duplicate" ? "copy" : "remix"}`;
			setName(suggested.slice(0, 100));
			setSlug(slugFrom(suggested));
			setDialogError("");
		}
	}, [source]);
	const duplicate = source?.kind === "duplicate";
	return (
		<Dialog onOpenChange={onOpenChange} open={source !== null}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{duplicate ? "Duplicate site" : "Remix site"}
					</DialogTitle>
					<DialogDescription>
						{duplicate
							? tl(
									"Starts a new private site from the latest saved version. Only the page and its runtime choice are copied. Sharing, editors, domains, connections, database, files, shared data and analytics stay with the original."
								)
							: tl(
									"Starts a new private site you own from the deployed version. Only the page and its runtime choice are copied. Sharing, editors, domains, connections, database, files, shared data and analytics stay with the original."
								)}
					</DialogDescription>
				</DialogHeader>
				{dialogError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{dialogError}
					</p>
				) : null}
				<RyuAppField label="Name">
					<Input
						aria-label="New site name"
						maxLength={100}
						onChange={(event) => {
							setName(event.target.value);
							setSlug(slugFrom(event.target.value));
						}}
						value={name}
					/>
				</RyuAppField>
				<RyuAppField label="URL name">
					<Input
						aria-label="New site URL name"
						maxLength={48}
						onChange={(event) => setSlug(event.target.value)}
						value={slug}
					/>
				</RyuAppField>
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="outline">
						Cancel
					</Button>
					<Button
						disabled={busy || !source || !name.trim() || slug.length < 5}
						onClick={() =>
							source &&
							void run(async () => {
								setDialogError("");
								let created: RuntimeSite;
								try {
									created = await sitesRequest(
										runtimeSiteSchema,
										`/projects/${encodeURIComponent(source.id)}/remix`,
										"POST",
										{ name, slug }
									);
								} catch (cause) {
									setDialogError(
										cause instanceof Error
											? cause.message
											: "The site could not be copied."
									);
									return;
								}
								await onCreated(created);
							})
						}
					>
						{duplicate ? "Duplicate site" : "Remix site"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** One-line provenance for a Site started from another one. */
export function provenanceLabel(site: RuntimeSite): string | null {
	return site.remixedFrom ? `Remixed from ${site.remixedFrom.name}` : null;
}

/**
 * Built-in starters and the Sites other people let the caller remix. Template
 * thumbnails render the starter without scripts in an empty sandbox.
 */
export function SitesGallery({
	busy,
	onRemix,
	onUseTemplate,
}: {
	busy: boolean;
	onRemix: (source: RemixSource) => void;
	onUseTemplate: (template: SiteTemplate) => void;
}) {
	const tl = useLiteralMessages();
	const [remixable, setRemixable] = useState<RemixableSite[]>([]);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [loadError, setLoadError] = useState("");
	const load = useCallback(async () => {
		setState("loading");
		try {
			setRemixable(
				await sitesRequest(remixableSitesSchema, "/projects?scope=remixable")
			);
			setState("ready");
		} catch (cause) {
			setLoadError(
				cause instanceof Error
					? cause.message
					: "Remixable sites are unavailable."
			);
			setState("error");
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	return (
		<div className="grid gap-8" data-testid="sites-gallery">
			<section aria-labelledby="gallery-templates" className="grid gap-4">
				<div>
					<h2 className="font-medium text-xl" id="gallery-templates">
						Templates
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						Start private from a built-in example.
					</p>
				</div>
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					{SITE_TEMPLATES.map((template) => (
						<article
							className="flex flex-col rounded-lg border bg-card p-4"
							key={template.id}
						>
							<iframe
								aria-hidden="true"
								className="pointer-events-none h-40 w-full rounded-md border bg-white"
								loading="lazy"
								sandbox=""
								srcDoc={starterHtml(template.name, template.id, "")}
								tabIndex={-1}
								title={tl("{templateName} preview", {
									templateName: template.name,
								})}
							/>
							<h3 className="mt-4 font-medium">{template.name}</h3>
							<p className="mt-1 flex-1 text-muted-foreground text-sm">
								{template.description}
							</p>
							<Button
								className="mt-4 self-start"
								disabled={busy}
								onClick={() => onUseTemplate(template.id)}
								variant="outline"
							>
								Use template
							</Button>
						</article>
					))}
				</div>
			</section>
			<section aria-labelledby="gallery-remixable" className="grid gap-4">
				<div>
					<h2 className="font-medium text-xl" id="gallery-remixable">
						Remixable sites
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						Sites you can visit whose owners allow remixing. A remix copies the
						deployed page into a new private site you own; a site you edit is
						duplicated from its latest saved version.
					</p>
				</div>
				{state === "loading" ? (
					<p role="status">Loading remixable sites…</p>
				) : state === "error" ? (
					<div
						className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 p-3 text-sm"
						role="alert"
					>
						<span>{loadError}</span>
						<Button onClick={() => void load()} variant="outline">
							Retry
						</Button>
					</div>
				) : remixable.length ? (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{remixable.map((item) => (
							<article className="rounded-lg border bg-card p-4" key={item.id}>
								<Badge variant="outline">
									{item.access === "editor" ? "You edit" : "Shared"} ·{" "}
									{item.template}
								</Badge>
								<h3 className="mt-3 font-medium">{item.name}</h3>
								<p className="mt-1 truncate text-muted-foreground text-xs">
									{tl("{slug} · Updated {updatedAt}", {
										slug: item.slug,
										updatedAt: formatDateTime(item.updatedAt),
									})}
								</p>
								<Button
									className="mt-4"
									disabled={busy}
									onClick={() =>
										// Editors copy the latest saved version, as the sidecar does.
										onRemix({
											id: item.id,
											kind: item.access === "editor" ? "duplicate" : "remix",
											name: item.name,
										})
									}
								>
									{item.access === "editor" ? "Duplicate" : "Remix"}
								</Button>
							</article>
						))}
					</div>
				) : (
					<RyuAppEmpty
						description="When someone lets you remix a site they share with you, it appears here."
						title="No remixable sites"
					/>
				)}
			</section>
		</div>
	);
}
