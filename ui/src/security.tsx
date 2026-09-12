import { RyuAppEmpty, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Badge, Button } from "@ryu/blocks/companion/controls";
import { useCallback, useEffect, useState } from "react";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import { projectPath, sitesRequest } from "./api.ts";

interface SecurityReport {
	artifactDigest: string;
	checkedAt: string;
	limitation: string;
	protections: { name: string; detail: string }[];
	status: "passed" | "blocked" | "unavailable";
	summary: string;
	versionId: string;
}

export function SiteSecurityPanel({ site }: { site: RuntimeSite }) {
	const [report, setReport] = useState<SecurityReport | null>(null);
	const [error, setError] = useState("");
	const [running, setRunning] = useState(false);
	const latest = site.versions.at(-1);
	const scan = useCallback(async () => {
		if (!latest) {
			return;
		}
		setRunning(true);
		setError("");
		try {
			setReport(
				await sitesRequest<SecurityReport>(
					`${projectPath(site, "security")}?versionId=${latest.id}`
				)
			);
		} catch (cause) {
			setReport(null);
			setError(
				cause instanceof Error ? cause.message : "Security check unavailable"
			);
		} finally {
			setRunning(false);
		}
	}, [site, latest]);
	useEffect(() => {
		void scan();
	}, [scan]);
	if (!latest) {
		return (
			<RyuAppEmpty
				description="Deployment checks inspect a saved build. Unsaved edits are not part of that result."
				title="Save a version to check it"
			/>
		);
	}
	return (
		<RyuAppSection title="Security">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h2 className="font-medium text-xl">
						Checks for version {site.versions.length}
					</h2>
					<p className="mt-2 text-muted-foreground text-sm">
						Deployment repeats the secret check on the exact version being
						published.
					</p>
				</div>
				<Button
					disabled={running}
					onClick={() => void scan()}
					variant="outline"
				>
					{running ? "Checking…" : "Run check again"}
				</Button>
			</div>
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{report ? (
				<>
					<div className="rounded-lg border p-5">
						<Badge
							variant={report.status === "blocked" ? "destructive" : "outline"}
						>
							{report.status === "passed"
								? "Secret check passed"
								: report.status === "blocked"
									? "Deployment blocked"
									: "Check unavailable"}
						</Badge>
						<p className="mt-3 text-sm" role="status">
							{report.summary}
						</p>
						<p className="mt-3 text-muted-foreground text-xs">
							Checked {new Date(report.checkedAt).toLocaleString()} · Build{" "}
							{report.artifactDigest.slice(0, 12)}
						</p>
					</div>
					<div className="grid gap-4 md:grid-cols-2">
						{report.protections.map((protection) => (
							<section className="border-t py-4" key={protection.name}>
								<h3 className="font-medium">{protection.name}</h3>
								<p className="mt-2 text-muted-foreground text-sm">
									{protection.detail}
								</p>
							</section>
						))}
					</div>
					<p className="text-muted-foreground text-sm">{report.limitation}</p>
				</>
			) : running ? (
				<p role="status">Checking the saved version with Gateway…</p>
			) : null}
		</RyuAppSection>
	);
}
