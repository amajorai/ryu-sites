import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import {
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
	Textarea,
} from "@ryu/blocks/companion/controls";
import { useEffect, useState } from "react";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import { sitesRequest } from "./api.ts";
import { runtimeSiteSchema } from "./schemas.ts";
import type { Run } from "./settings-run.ts";

export function CreateSiteDialog({
	open,
	setOpen,
	busy,
	run,
	onCreate,
	initialTemplate = "help-center",
}: {
	open: boolean;
	setOpen: (value: boolean) => void;
	busy: boolean;
	run: Run;
	onCreate: (site: RuntimeSite) => Promise<void>;
	/** The template preselected when the dialog opens, e.g. from the Gallery. */
	initialTemplate?: RuntimeSite["template"];
}) {
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [template, setTemplate] = useState<string>(initialTemplate);
	const [prompt, setPrompt] = useState("");
	const [dialogError, setDialogError] = useState("");
	useEffect(() => {
		if (open) {
			setTemplate(initialTemplate);
		}
	}, [open, initialTemplate]);
	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (nextOpen) {
					setDialogError("");
				}
				setOpen(nextOpen);
			}}
			open={open}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create a site</DialogTitle>
					<DialogDescription>
						Start private with a useful template. Deploy only when ready.
					</DialogDescription>
				</DialogHeader>
				{dialogError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{dialogError}
					</p>
				) : null}
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
							void run(async () => {
								setDialogError("");
								let created: RuntimeSite;
								try {
									created = await sitesRequest(
										runtimeSiteSchema,
										"/projects",
										"POST",
										{ name, slug, template, prompt }
									);
								} catch (cause) {
									setDialogError(
										cause instanceof Error
											? cause.message
											: "The site could not be created."
									);
									return;
								}
								await onCreate(created);
							})
						}
					>
						Create site
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
