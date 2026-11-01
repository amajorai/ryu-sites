import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Label, Textarea } from "@ryu/blocks/companion/controls";
import type { Dispatch, SetStateAction } from "react";
import type { Panel } from "./App-panel.ts";

export function SiteEditorPanel({
	busy,
	generate,
	html,
	mobile,
	panel,
	preview,
	prompt,
	run,
	setHtml,
	setMobile,
	setNotice,
	setPrompt,
}: {
	busy: boolean;
	generate: () => unknown;
	html: string;
	mobile: boolean;
	panel: Panel;
	preview: string;
	prompt: string;
	run: (work: () => Promise<void>) => Promise<void>;
	setHtml: (html: string) => void;
	setMobile: Dispatch<SetStateAction<boolean>>;
	setNotice: (notice: string) => void;
	setPrompt: (prompt: string) => void;
}) {
	return (
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
								setNotice("Imported for review. Save a version to keep it.");
							});
						}
					}}
					type="file"
				/>
				<p className="text-muted-foreground text-xs">
					Build your project first. Package scripts are not executed during
					import.
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
							className="sites-preview-frame mx-auto min-h-[600px] w-full rounded-lg border bg-white"
							data-preview-width={mobile ? "mobile" : "desktop"}
							sandbox="allow-scripts"
							srcDoc={preview}
							title="Website preview"
						/>
					</>
				)}
			</section>
		</div>
	);
}
