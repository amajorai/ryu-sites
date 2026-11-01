import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Badge, Button, Input } from "@ryu/blocks/companion/controls";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import type { SiteDataRecord } from "../../sidecar/src/data-values.ts";
import type { ServiceStatus } from "./schemas.ts";

export function SiteGeneralSection({
	site,
	status,
	busy,
	name,
	setName,
	slug,
	setSlug,
	domain,
	setDomain,
	mutate,
	setDeleteOpen,
}: {
	site: RuntimeSite;
	status: ServiceStatus;
	busy: boolean;
	name: string;
	setName: (value: string) => void;
	slug: string;
	setSlug: (value: string) => void;
	domain: string;
	setDomain: (value: string) => void;
	mutate: (
		action: string,
		method: "POST" | "PUT" | "DELETE",
		body: SiteDataRecord
	) => Promise<void>;
	setDeleteOpen: (value: boolean) => void;
}) {
	return (
		<RyuAppSection title="General and domains">
			<RyuAppField label="Name">
				<Input
					aria-label="Site name"
					onChange={(event) => setName(event.target.value)}
					value={name}
				/>
			</RyuAppField>
			<Button
				disabled={busy || !name.trim() || name === site.name}
				onClick={() => void mutate("name", "PUT", { name })}
				variant="outline"
			>
				Save name
			</Button>
			<RyuAppField label="Site URL name">
				<Input
					aria-label="Site URL name"
					onChange={(event) => setSlug(event.target.value)}
					value={slug}
				/>
			</RyuAppField>
			<Button
				disabled={busy || slug === site.slug}
				onClick={() => void mutate("url", "PUT", { slug })}
				variant="outline"
			>
				Change URL
			</Button>
			<p className="text-muted-foreground text-xs">
				Old names redirect to the new name. Custom domains are separate.
			</p>
			<RyuAppField label="Custom domain">
				<Input
					aria-label="Custom domain"
					onChange={(event) => setDomain(event.target.value)}
					placeholder="help.example.com"
					value={domain}
				/>
			</RyuAppField>
			<Button
				disabled={busy || !domain || status.domainsAvailable !== true}
				onClick={() => void mutate("domains", "POST", { host: domain })}
				variant="outline"
			>
				Add domain
			</Button>
			{status.domainsAvailable === true ? null : (
				<p className="text-muted-foreground text-xs">
					No edge or TLS provider is configured on this node, so custom domains
					stay pending TLS and do not serve traffic.
				</p>
			)}
			{site.domains.map((binding) => (
				<section className="rounded-lg border p-3" key={binding.host}>
					<p>
						{binding.host}{" "}
						<Badge variant="outline">
							{binding.status.replaceAll("_", " ")}
						</Badge>
					</p>
					<p className="mt-2 break-all text-xs">
						TXT _ryu-sites.{binding.host} = {binding.verification}
					</p>
					<div className="mt-3 flex gap-2">
						<Button
							disabled={busy}
							onClick={() =>
								void mutate("domains/check", "POST", { host: binding.host })
							}
							size="sm"
							variant="outline"
						>
							Check DNS and TLS
						</Button>
						<Button
							disabled={busy}
							onClick={() =>
								void mutate("domains", "DELETE", { host: binding.host })
							}
							size="sm"
							variant="ghost"
						>
							Remove
						</Button>
					</div>
				</section>
			))}
			<p className="text-muted-foreground text-xs">
				Live requires both ownership verification and an active TLS/edge
				binding.
			</p>
			<Button
				disabled={busy || !site.deploymentId}
				onClick={() => void mutate("unpublish", "POST", {})}
				variant="outline"
			>
				Take site offline
			</Button>
			<Button
				disabled={busy}
				onClick={() => setDeleteOpen(true)}
				variant="destructive"
			>
				Delete site
			</Button>
		</RyuAppSection>
	);
}
