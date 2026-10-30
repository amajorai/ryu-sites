export type { ServiceStatus } from "./schemas.ts";
export { Analytics } from "./settings-analytics.tsx";
export { CreateSiteDialog } from "./settings-create-dialog.tsx";

import { RyuAppEmpty, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useState } from "react";
import type {
	ResetActionResult,
	ResetProvider,
	RuntimeSite,
	SiteSettings,
} from "../../sidecar/src/contracts.ts";
import type { SiteDataRecord } from "../../sidecar/src/data-values.ts";
import { projectPath, sitesRequest } from "./api.ts";
import type { ServiceStatus } from "./schemas.ts";
import { runtimeSiteSchema } from "./schemas.ts";
import { SiteAccessSection } from "./settings-access-section.tsx";
import { SiteDeleteDialog, SiteResetDialog } from "./settings-dialogs.tsx";
import { SiteGeneralSection } from "./settings-general-section.tsx";
import type { Run } from "./settings-run.ts";

export function SiteSettingsPanel({
	site,
	status,
	busy,
	run,
	replace,
	onDelete,
}: {
	site: RuntimeSite;
	status: ServiceStatus;
	busy: boolean;
	run: Run;
	replace: (site: RuntimeSite) => void;
	onDelete: () => void;
}) {
	const [settings, setSettings] = useState<SiteSettings>(site.settings);
	const [name, setName] = useState(site.name);
	const [slug, setSlug] = useState(site.slug);
	const [domain, setDomain] = useState("");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const [resetProvider, setResetProvider] = useState<ResetProvider | null>(
		null
	);
	const [resetReport, setResetReport] = useState<ResetActionResult | null>(
		null
	);
	const update = (patch: Partial<SiteSettings>) =>
		setSettings((current) => ({ ...current, ...patch }));
	const mutate = (
		action: string,
		method: "POST" | "PUT" | "DELETE",
		body: SiteDataRecord
	) =>
		run(async () =>
			replace(
				await sitesRequest(
					runtimeSiteSchema,
					projectPath(site, action),
					method,
					{
						...body,
						expectedRevision: site.revision,
					}
				)
			)
		);
	return (
		<div className="grid gap-8 lg:grid-cols-2">
			<SiteAccessSection
				busy={busy}
				mutate={mutate}
				resetReport={resetReport}
				setResetProvider={setResetProvider}
				settings={settings}
				site={site}
				status={status}
				update={update}
			/>
			<SiteGeneralSection
				busy={busy}
				domain={domain}
				mutate={mutate}
				name={name}
				setDeleteOpen={setDeleteOpen}
				setDomain={setDomain}
				setName={setName}
				setSlug={setSlug}
				site={site}
				slug={slug}
				status={status}
			/>
			<RyuAppSection title="Environment variables">
				<RyuAppEmpty
					description="Sites currently serves static visitor pages. API keys and private environment values cannot be used there safely yet. Keep secrets out of generated HTML."
					title="Server-side variables unavailable"
				/>
			</RyuAppSection>
			<SiteResetDialog
				busy={busy}
				resetProvider={resetProvider}
				run={run}
				setResetProvider={setResetProvider}
				setResetReport={setResetReport}
				site={site}
			/>
			<SiteDeleteDialog
				busy={busy}
				confirmation={confirmation}
				deleteOpen={deleteOpen}
				onDelete={onDelete}
				run={run}
				setConfirmation={setConfirmation}
				setDeleteOpen={setDeleteOpen}
				site={site}
			/>
		</div>
	);
}
