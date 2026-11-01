import { RyuAppEmpty, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import { projectPath, sitesRequest } from "./api.ts";
import {
	type VisitorDataReport,
	visitorDataPurgeSchema,
	visitorDataReportSchema,
} from "./schemas.ts";

type VisitorData = VisitorDataReport["visitors"][number];

const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * KILOBYTE;

/** Stored size with one decimal, in the shared numeric display policy. */
export function formatStoredSize(bytes: number): string {
	if (bytes < KILOBYTE) {
		return `${formatNumber(bytes)} B`;
	}
	if (bytes < MEGABYTE) {
		return `${formatNumber(Math.round((bytes / KILOBYTE) * 10) / 10)} KB`;
	}
	return `${formatNumber(Math.round((bytes / MEGABYTE) * 10) / 10)} MB`;
}

const errorMessage = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/**
 * Owner view of each signed-in visitor's saved records and uploaded files in
 * one Site, with an audited purge per visitor.
 */
export function SiteVisitorDataPanel({ site }: { site: RuntimeSite }) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const [report, setReport] = useState<VisitorDataReport | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [target, setTarget] = useState<VisitorData | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const currentSite = useRef(site.id);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		void sitesRequest(
			visitorDataReportSchema,
			projectPath(site, "visitors"),
			"GET"
		)
			.then((data) => {
				if (active) {
					setReport(data);
				}
			})
			.catch((cause) => {
				if (active) {
					setReport(null);
					setError(errorMessage(cause, "Visitor data is unavailable"));
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [site, refresh]);

	useEffect(() => {
		currentSite.current = site.id;
		setNotice("");
		setTarget(null);
		return () => {
			currentSite.current = "";
		};
	}, [site.id]);

	const purge = async (visitor: VisitorData) => {
		const siteId = site.id;
		setDeleting(true);
		setError("");
		setNotice("");
		try {
			const result = await sitesRequest(
				visitorDataPurgeSchema,
				projectPath(site, `visitors/${visitor.visitor}/data`),
				"DELETE"
			);
			if (currentSite.current !== siteId) {
				return;
			}
			setTarget(null);
			setNotice(
				tl("Deleted {recordCount} records and {fileCount} files.", {
					recordCount: formatNumber(result.deleted.records),
					fileCount: formatNumber(result.deleted.files),
				})
			);
			setRefresh((count) => count + 1);
		} catch (cause) {
			if (currentSite.current === siteId) {
				setTarget(null);
				setError(errorMessage(cause, "The visitor data could not be deleted"));
			}
		} finally {
			setDeleting(false);
		}
	};

	const visitors = report?.visitors ?? [];
	const audit = report?.audit ?? [];
	let content: ReactNode = null;
	if (loading && !report) {
		content = (
			<p className="text-muted-foreground text-sm" role="status">
				Loading visitor data…
			</p>
		);
	} else if (visitors.length) {
		content = (
			<div className="max-h-80 overflow-auto rounded-md border">
				<table className="w-full text-left text-sm">
					<thead className="sticky top-0 bg-muted">
						<tr>
							<th className="px-3 py-2 font-medium" scope="col">
								Visitor account
							</th>
							<th className="px-3 py-2 font-medium" scope="col">
								Records
							</th>
							<th className="px-3 py-2 font-medium" scope="col">
								Record size
							</th>
							<th className="px-3 py-2 font-medium" scope="col">
								Files
							</th>
							<th className="px-3 py-2 font-medium" scope="col">
								File size
							</th>
							<th className="px-3 py-2" scope="col">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{visitors.map((visitor) => (
							<tr className="border-t" key={visitor.visitor}>
								<td
									className="max-w-64 truncate px-3 py-2 font-mono text-xs"
									data-ryu-i18n="off"
									title={visitor.owner}
								>
									{visitor.owner}
								</td>
								<td className="px-3 py-2 tabular-nums">
									{formatNumber(visitor.records)}
									{visitor.sharedRecords
										? ` ${tl("({sharedCount} shared)", {
												sharedCount: formatNumber(visitor.sharedRecords),
											})}`
										: ""}
								</td>
								<td className="px-3 py-2 tabular-nums">
									{formatStoredSize(visitor.recordBytes)}
								</td>
								<td className="px-3 py-2 tabular-nums">
									{formatNumber(visitor.files)}
								</td>
								<td className="px-3 py-2 tabular-nums">
									{formatStoredSize(visitor.fileBytes)}
								</td>
								<td className="px-3 py-2 text-end">
									<Button
										aria-label={tl("Delete data saved by {owner}", {
											owner: visitor.owner,
										})}
										disabled={deleting}
										onClick={() => setTarget(visitor)}
										size="sm"
										variant="ghost"
									>
										Delete data
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		);
	} else if (!(loading || error)) {
		content = (
			<RyuAppEmpty
				description="Records and files appear here after signed-in visitors save them on the deployed Site."
				title="No visitor data"
			/>
		);
	}

	return (
		<RyuAppSection title="Visitor data">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-prose text-muted-foreground text-sm">
					Saved records and uploaded files for each signed-in visitor. Deleting
					a visitor's data removes it permanently; the visitor can keep using
					the Site.
				</p>
				{/* The Database section above has its own Refresh; name this one for
				    its section so the two controls stay distinguishable. */}
				<Button
					aria-label="Refresh visitor data"
					disabled={loading || deleting}
					onClick={() => setRefresh((count) => count + 1)}
					variant="outline"
				>
					Refresh
				</Button>
			</div>
			{notice ? (
				<p className="text-sm text-status-success" role="status">
					{notice}
				</p>
			) : null}
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{content}
			{audit.length ? (
				<div className="grid gap-2">
					<h3 className="font-medium text-sm">Recent deletions</h3>
					<ul className="grid gap-1 text-muted-foreground text-xs">
						{audit.map((entry) => (
							<li
								key={`${entry.at}:${entry.visitor}:${entry.records}:${entry.files}`}
							>
								{tlRich(
									"{deletedAt} · visitor digest <code>{visitor}</code> · {recordCount} records, {fileCount} files",
									{
										deletedAt: formatDateTime(entry.at),
										fileCount: formatNumber(entry.files),
										recordCount: formatNumber(entry.records),
										visitor: entry.visitor,
									},
									{
										code: (chunks) => <code data-ryu-i18n="off">{chunks}</code>,
									}
								)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<Dialog
				onOpenChange={(open) => {
					if (!(open || deleting)) {
						setTarget(null);
					}
				}}
				open={target !== null}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete this visitor's data?</DialogTitle>
						<DialogDescription>
							{target
								? tl(
										"{recordCount} records and {fileCount} files ({totalSize}) saved by {owner} will be permanently deleted. The deletion is recorded in this Site's audit list.",
										{
											recordCount: formatNumber(target.records),
											fileCount: formatNumber(target.files),
											totalSize: formatStoredSize(
												target.recordBytes + target.fileBytes
											),
											owner: target.owner,
										}
									)
								: ""}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							disabled={deleting}
							onClick={() => setTarget(null)}
							variant="outline"
						>
							Cancel
						</Button>
						<Button
							disabled={deleting || target === null}
							onClick={() => {
								if (target) {
									void purge(target);
								}
							}}
							variant="destructive"
						>
							{deleting ? "Deleting…" : "Delete permanently"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</RyuAppSection>
	);
}
