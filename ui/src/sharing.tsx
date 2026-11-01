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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import type { RuntimeSite, SiteSettings } from "../../sidecar/src/contracts.ts";
import { projectPath, sitesRequest } from "./api.ts";
import { runtimeSiteSchema } from "./schemas.ts";
import type { ServiceStatus } from "./settings.tsx";

type Run = (work: () => Promise<void>) => Promise<void>;

function siteUrl(site: RuntimeSite, status: ServiceStatus): string {
	const activeDomain = site.domains.find(
		(domain) => domain.status === "active"
	);
	if (activeDomain) {
		return `https://${activeDomain.host}/`;
	}
	return status.baseDomain === "localhost"
		? `http://${site.slug}.localhost:${status.visitorPort}/`
		: `https://${site.slug}.${status.baseDomain}/`;
}

function isAudience(value: string): value is SiteSettings["audience"] {
	return ["private", "invited", "workspace", "public"].includes(value);
}

export function SiteSharingDialog({
	open,
	onOpenChange,
	site,
	status,
	busy,
	run,
	replace,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	site: RuntimeSite;
	status: ServiceStatus;
	busy: boolean;
	run: Run;
	replace: (site: RuntimeSite) => void;
}) {
	const tl = useLiteralMessages();
	const [audience, setAudience] = useState<SiteSettings["audience"]>(
		site.settings.audience
	);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"viewer" | "editor">("viewer");
	const [linkNotice, setLinkNotice] = useState("");
	const [saveError, setSaveError] = useState("");
	useEffect(() => {
		if (open) {
			setAudience(site.settings.audience);
			setEmail("");
			setRole("viewer");
			setLinkNotice("");
			setSaveError("");
		}
	}, [open, site.id, site.revision, site.settings.audience]);

	const save = (settings: SiteSettings) =>
		run(async () => {
			setSaveError("");
			try {
				const saved = await sitesRequest(
					runtimeSiteSchema,
					projectPath(site, "settings"),
					"PUT",
					{ expectedRevision: site.revision, settings }
				);
				replace(saved);
				setAudience(saved.settings.audience);
			} catch (cause) {
				setSaveError(
					cause instanceof Error ? cause.message : "Sharing could not be saved."
				);
				throw cause;
			}
		});
	const changeAudience = (value: SiteSettings["audience"]) => {
		void save({ ...site.settings, audience: value });
	};
	const addPerson = () => {
		const normalized = email.trim().toLowerCase();
		if (!normalized.includes("@")) {
			return;
		}
		const viewers =
			role === "viewer"
				? [...new Set([...site.settings.viewers, normalized])]
				: site.settings.viewers.filter((value) => value !== normalized);
		const editors =
			role === "editor"
				? [...new Set([...site.settings.editors, normalized])]
				: site.settings.editors.filter((value) => value !== normalized);
		const nextAudience =
			role === "viewer" && audience === "private" ? "invited" : audience;
		void save({ ...site.settings, viewers, editors, audience: nextAudience });
	};
	const removePerson = (emailToRemove: string) => {
		void save({
			...site.settings,
			viewers: site.settings.viewers.filter((value) => value !== emailToRemove),
			editors: site.settings.editors.filter((value) => value !== emailToRemove),
		});
	};
	const copyLink = async () => {
		try {
			await navigator.clipboard.writeText(siteUrl(site, status));
			setLinkNotice("Link copied");
		} catch {
			setLinkNotice("Clipboard access is unavailable");
		}
	};
	const people = [
		...site.settings.viewers.map((email) => ({ email, role: "Viewer" })),
		...site.settings.editors.map((email) => ({ email, role: "Editor" })),
	];

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{tl("Share {siteName}", { siteName: site.name })}
					</DialogTitle>
					<DialogDescription>
						Choose who can visit this Site. Editors can save and deploy changes.
					</DialogDescription>
				</DialogHeader>
				{saveError ? (
					<div
						className="rounded-lg border border-destructive/30 p-3 text-sm"
						role="alert"
					>
						<p>{saveError}</p>
						<p className="mt-1 text-muted-foreground">
							Retry the change. If the Site has changed, close this dialog and
							choose Reload first.
						</p>
					</div>
				) : null}
				<div className="rounded-lg border bg-muted/40 p-3">
					<p className="font-medium text-sm">{site.name}</p>
					<p className="mt-1 break-all text-muted-foreground text-xs">
						{siteUrl(site, status)}
					</p>
				</div>
				<label className="grid gap-2 text-sm" htmlFor="site-share-email">
					Email address
					<div className="flex gap-2">
						<Input
							autoComplete="email"
							id="site-share-email"
							onChange={(event) => setEmail(event.target.value)}
							placeholder="name@example.com"
							type="email"
							value={email}
						/>
						<Select
							onValueChange={(value) => {
								if (value === "viewer" || value === "editor") {
									setRole(value);
								}
							}}
							value={role}
						>
							<SelectTrigger aria-label="Access role" className="w-28">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="viewer">Viewer</SelectItem>
								<SelectItem
									disabled={!site.settings.workspaceId}
									value="editor"
								>
									Editor
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</label>
				<Button
					className="w-fit"
					disabled={
						busy || !status.identityAvailable || !email.trim().includes("@")
					}
					onClick={addPerson}
					variant="outline"
				>
					Add person
				</Button>
				<div className="grid gap-2">
					<p className="font-medium text-sm">Who has access</p>
					<div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
						<span className="text-sm">You</span>
						<Badge variant="outline">Owner</Badge>
					</div>
					{people.map((person) => (
						<div
							className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2"
							key={`${person.role}:${person.email}`}
						>
							<div className="min-w-0">
								<p className="truncate text-sm" title={person.email}>
									{person.email}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<Badge variant="outline">{person.role}</Badge>
								<Button
									aria-label={tl("Remove {email}", { email: person.email })}
									disabled={busy}
									onClick={() => removePerson(person.email)}
									size="sm"
									variant="ghost"
								>
									Remove
								</Button>
							</div>
						</div>
					))}
				</div>
				<label className="grid gap-2 text-sm" htmlFor="site-sharing-audience">
					Who can visit
					<Select
						disabled={busy}
						onValueChange={(value) => {
							if (isAudience(value)) {
								changeAudience(value);
							}
						}}
						value={audience}
					>
						<SelectTrigger
							aria-label="Who can visit"
							id="site-sharing-audience"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="private">Just me</SelectItem>
							<SelectItem disabled={!status.identityAvailable} value="invited">
								Invited viewers
							</SelectItem>
							<SelectItem
								disabled={
									!(status.identityAvailable && site.settings.workspaceId)
								}
								value="workspace"
							>
								Workspace
							</SelectItem>
							<SelectItem disabled={!status.publicEnabled} value="public">
								Anyone with the link
							</SelectItem>
						</SelectContent>
					</Select>
				</label>
				{site.settings.audience === "public" && !status.publicEnabled ? (
					<p className="text-muted-foreground text-xs" role="status">
						Public publishing is disabled by the operator, so this Site's public
						access is suspended. Choose another audience to change sharing.
					</p>
				) : null}
				<DialogFooter>
					<Button onClick={() => void copyLink()} variant="outline">
						Copy link
					</Button>
					{site.deploymentId ? (
						<a
							className="inline-flex h-9 items-center rounded-md border px-3 text-sm"
							href={siteUrl(site, status)}
							rel="noopener noreferrer"
							target="_blank"
						>
							Visit
						</a>
					) : null}
				</DialogFooter>
				{linkNotice ? (
					<p className="text-muted-foreground text-xs" role="status">
						{linkNotice}
					</p>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
