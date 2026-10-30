import { RyuAppEmpty, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import type { RuntimeSite } from "../../sidecar/src/contracts.ts";
import styles from "./analytics.module.css";
import { projectPath, sitesRequest } from "./api.ts";
import type { AnalyticsReport } from "./schemas.ts";
import { analyticsReportSchema } from "./schemas.ts";

export function Analytics({ site }: { site: RuntimeSite }) {
	const tl = useLiteralMessages();
	const [report, setReport] = useState<AnalyticsReport | null>(null);
	const [days, setDays] = useState("7");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		void sitesRequest(
			analyticsReportSchema,
			`${projectPath(site, "analytics")}?days=${days}`
		)
			.then((data) => {
				if (active) {
					setReport(data);
				}
			})
			.catch((cause) => {
				if (active) {
					setError(
						cause instanceof Error ? cause.message : "Analytics unavailable"
					);
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
	}, [site.id, days]);
	const dayCount = Number(days);
	const rowByDay = new Map(report?.daily.map((row) => [row.day, row]) ?? []);
	const points = Array.from({ length: dayCount }, (_, index) => {
		const date = new Date(Date.now() - (dayCount - index - 1) * 86_400_000)
			.toISOString()
			.slice(0, 10);
		return rowByDay.get(date) ?? { day: date, pageViews: 0, uniqueVisitors: 0 };
	});
	const maxValue = Math.max(
		1,
		...points.map((point) => Math.max(point.pageViews, point.uniqueVisitors))
	);
	const xFor = (index: number) =>
		62 + (index / Math.max(1, points.length - 1)) * 900;
	const yFor = (value: number) => 205 - (value / maxValue) * 170;
	const visitorLine = points
		.map((point, index) => `${xFor(index)},${yFor(point.uniqueVisitors)}`)
		.join(" ");
	const pageLine = points
		.map((point, index) => `${xFor(index)},${yFor(point.pageViews)}`)
		.join(" ");
	const labels = [
		points[0],
		points[Math.floor(points.length / 2)],
		points.at(-1),
	].filter((point): point is (typeof points)[number] => point !== undefined);
	return (
		<div className="grid gap-5">
			<RyuAppSection title="Traffic">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-muted-foreground text-sm">
						Daily page requests and estimated unique visitors. No tracking
						cookie or analytics SDK; data is retained for 90 days.
					</p>
					<Select onValueChange={setDays} value={days}>
						<SelectTrigger aria-label="Analytics date range" className="w-36">
							<SelectValue>{tl("Last {days} days", { days })}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="7">Last 7 days</SelectItem>
							<SelectItem value="30">Last 30 days</SelectItem>
							<SelectItem value="90">Last 90 days</SelectItem>
						</SelectContent>
					</Select>
				</div>
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				{loading ? (
					<p className="text-muted-foreground text-sm" role="status">
						Loading analytics…
					</p>
				) : report?.summary.pageViews ? (
					<>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="rounded-lg border p-4">
								<p className="text-muted-foreground text-sm">Unique visitors</p>
								<p className="mt-1 font-medium text-2xl tabular-nums">
									{report.summary.uniqueVisitors}
								</p>
							</div>
							<div className="rounded-lg border p-4">
								<p className="text-muted-foreground text-sm">Page views</p>
								<p className="mt-1 font-medium text-2xl tabular-nums">
									{report.summary.pageViews}
								</p>
							</div>
						</div>
						<div className="rounded-lg border p-4">
							<p className="font-medium text-sm">Traffic over time</p>
							<p className="text-muted-foreground text-xs">Daily · UTC</p>
							<svg
								aria-label={tl(
									"Daily page views and unique visitors over {days} days",
									{ days }
								)}
								className="mt-3 w-full"
								role="img"
								viewBox="0 0 1000 250"
							>
								{[0, Math.floor(maxValue / 2), maxValue].map((tick, index) => {
									const y = yFor(tick);
									return (
										<g key={`${tick}-${index}`}>
											<line
												className="stroke-border"
												x1="54"
												x2="964"
												y1={y}
												y2={y}
											/>
											<text
												className={`fill-muted-foreground ${styles.axisLabel}`}
												textAnchor="end"
												x="45"
												y={y + 4}
											>
												{tick}
											</text>
										</g>
									);
								})}
								<polyline
									fill="none"
									points={visitorLine}
									stroke="var(--primary)"
									strokeWidth="3"
								/>
								<polyline
									fill="none"
									points={pageLine}
									stroke="var(--chart-2)"
									strokeWidth="3"
								/>
								{labels.map((point, index) => (
									<text
										className={`fill-muted-foreground ${styles.axisLabel}`}
										key={`${point.day}-${index}`}
										textAnchor={
											index === 0
												? "start"
												: index === labels.length - 1
													? "end"
													: "middle"
										}
										x={xFor(
											points.findIndex(
												(candidate) => candidate.day === point.day
											)
										)}
										y="235"
									>
										{new Date(`${point.day}T12:00:00Z`).toLocaleDateString(
											undefined,
											{ month: "short", day: "numeric", timeZone: "UTC" }
										)}
									</text>
								))}
							</svg>
							<div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-primary" />
									Unique visitors
								</span>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-chart-2" />
									Page views
								</span>
							</div>
							<details className="mt-4">
								<summary className="cursor-pointer text-muted-foreground text-sm">
									Daily counts
								</summary>
								<div className="mt-2 max-h-52 overflow-auto">
									<table className="w-full text-left text-sm">
										<thead className="sticky top-0 bg-background">
											<tr>
												<th className="py-2">Day</th>
												<th>Unique visitors</th>
												<th>Page views</th>
											</tr>
										</thead>
										<tbody>
											{points.map((point) => (
												<tr className="border-t" key={point.day}>
													<td className="py-2">{point.day}</td>
													<td>{point.uniqueVisitors}</td>
													<td>{point.pageViews}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</details>
						</div>
					</>
				) : (
					<RyuAppEmpty
						description="Traffic appears after the deployed Site receives visits."
						title="No traffic yet"
					/>
				)}
			</RyuAppSection>
			<RyuAppSection title="Top pages">
				{report?.topPages.length ? (
					<div className="overflow-auto">
						<table className="w-full text-left text-sm">
							<thead>
								<tr>
									<th className="py-3">Page</th>
									<th>Unique visitors</th>
									<th>Page views</th>
								</tr>
							</thead>
							<tbody>
								{report.topPages.map((page) => (
									<tr className="border-t" key={page.path}>
										<td className="max-w-96 truncate py-3" title={page.path}>
											{page.path}
										</td>
										<td>{page.uniqueVisitors}</td>
										<td>{page.pageViews}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<RyuAppEmpty
						description="Page paths appear after visitors load pages from this Site."
						title="No pages to show"
					/>
				)}
			</RyuAppSection>
		</div>
	);
}
