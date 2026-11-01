import {
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
import type {
	ResetActionResult,
	ResetProvider,
	RuntimeSite,
} from "../../sidecar/src/contracts.ts";
import { siteDataValueSchema } from "../../sidecar/src/data-values.ts";
import { projectPath, sitesRequest } from "./api.ts";
import { resetActionResultSchema } from "./schemas.ts";
import type { Run } from "./settings-run.ts";

export function SiteResetDialog({
	site,
	busy,
	run,
	resetProvider,
	setResetProvider,
	setResetReport,
}: {
	site: RuntimeSite;
	busy: boolean;
	run: Run;
	resetProvider: ResetProvider | null;
	setResetProvider: (provider: ResetProvider | null) => void;
	setResetReport: (report: ResetActionResult | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
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
						{tl("Check {provider} reset?", {
							provider: resetProvider
								? {
										codex: "Codex",
										claude: "Claude Code",
										copilot: "GitHub Copilot",
									}[resetProvider]
								: "provider",
						})}
					</DialogTitle>
					<DialogDescription>
						{tl(
							"Run one bounded agent check for your connected account on {name}. Ryu checks the provider's current usage first. A reset can be redeemed only through a separately authorized provider action.",
							{ name: site.name }
						)}
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
	);
}

export function SiteDeleteDialog({
	site,
	busy,
	run,
	deleteOpen,
	setDeleteOpen,
	confirmation,
	setConfirmation,
	onDelete,
}: {
	site: RuntimeSite;
	busy: boolean;
	run: Run;
	deleteOpen: boolean;
	setDeleteOpen: (value: boolean) => void;
	confirmation: string;
	setConfirmation: (value: string) => void;
	onDelete: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{tl("Permanently delete {name}?", { name: site.name })}
					</DialogTitle>
					<DialogDescription>
						{tl(
							"Versions, records, uploads, and analytics will be removed. Type {slug} to confirm.",
							{ slug: site.slug }
						)}
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
	);
}
