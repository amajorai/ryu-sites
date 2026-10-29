import { RyuAppEmpty, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Badge, Button, Label, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	type RuntimeSite,
	SHARED_RECORDS_OWNER,
} from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
import { projectPath, sitesRequest } from "./api.ts";
import type { QueryResult, SiteDatabaseSnapshot } from "./schemas.ts";
import {
	databaseSnapshotSchema,
	queryResultSchema,
	runtimeSiteSchema,
} from "./schemas.ts";

type Run = (work: () => Promise<void>) => Promise<void>;

function showValue(value: SiteDataValue): string {
	if (value === null) {
		return "NULL";
	}
	if (Array.isArray(value) || z.object({}).loose().safeParse(value).success) {
		return JSON.stringify(value) ?? "";
	}
	return String(value);
}

export function SiteDatabasePanel({
	site,
	available,
	busy,
	run,
	replace,
}: {
	site: RuntimeSite;
	available: boolean;
	busy: boolean;
	run: Run;
	replace: (site: RuntimeSite) => void;
}) {
	const tl = useLiteralMessages();
	const [snapshot, setSnapshot] = useState<SiteDatabaseSnapshot | null>(null);
	const [query, setQuery] = useState("SELECT * FROM data LIMIT 100");
	const [result, setResult] = useState<QueryResult | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [querying, setQuerying] = useState(false);
	const selectionGeneration = useRef(0);
	const refreshGeneration = useRef(0);
	const queryGeneration = useRef(0);
	const refresh = async () => {
		const selected = selectionGeneration.current;
		const request = ++refreshGeneration.current;
		const isCurrent = () =>
			selected === selectionGeneration.current &&
			request === refreshGeneration.current;
		setLoading(true);
		setError("");
		try {
			const data = await sitesRequest(
				databaseSnapshotSchema,
				projectPath(site, "database")
			);
			if (isCurrent()) {
				setSnapshot(data);
			}
		} catch (cause) {
			if (isCurrent()) {
				setError(
					cause instanceof Error ? cause.message : "Database unavailable"
				);
			}
		} finally {
			if (isCurrent()) {
				setLoading(false);
			}
		}
	};
	useEffect(() => {
		const selected = ++selectionGeneration.current;
		const request = ++refreshGeneration.current;
		const isCurrent = () =>
			selected === selectionGeneration.current &&
			request === refreshGeneration.current;
		setLoading(true);
		setError("");
		setSnapshot(null);
		setResult(null);
		setQuery("SELECT * FROM data LIMIT 100");
		setQuerying(false);
		void sitesRequest(databaseSnapshotSchema, projectPath(site, "database"))
			.then((data) => {
				if (isCurrent()) {
					setSnapshot(data);
				}
			})
			.catch((cause) => {
				if (isCurrent()) {
					setError(
						cause instanceof Error ? cause.message : "Database unavailable"
					);
				}
			})
			.finally(() => {
				if (isCurrent()) {
					setLoading(false);
				}
			});
		return () => {
			selectionGeneration.current += 1;
		};
	}, [site.id, site.revision]);

	const connect = () =>
		run(async () => {
			const connected = await sitesRequest(
				runtimeSiteSchema,
				projectPath(site, "database/connect"),
				"POST",
				{ expectedRevision: site.revision }
			);
			replace(connected);
			setResult(null);
		});
	const runQuery = async () => {
		const selected = selectionGeneration.current;
		const request = ++queryGeneration.current;
		const isCurrent = () =>
			selected === selectionGeneration.current &&
			request === queryGeneration.current;
		setQuerying(true);
		setError("");
		setResult(null);
		try {
			const data = await sitesRequest(
				queryResultSchema,
				projectPath(site, "database/query"),
				"POST",
				{ query }
			);
			if (isCurrent()) {
				setResult(data);
			}
		} catch (cause) {
			if (isCurrent()) {
				setError(
					cause instanceof Error ? cause.message : "The query could not run"
				);
			}
		} finally {
			if (isCurrent()) {
				setQuerying(false);
			}
		}
	};

	return (
		<RyuAppSection title="Ryu Spaces database">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p className="text-sm">
						{loading
							? "Checking database connection…"
							: snapshot?.connected
								? tl("{recordCount} records in this Site database", {
										recordCount: String(snapshot.records ?? 0),
									})
								: "No database connected"}
					</p>
					{snapshot?.connected ? (
						<p className="mt-1 text-muted-foreground text-sm">
							Visitor records are stored in this Site’s private Space.
							{snapshot.sharedRecords
								? ` ${tl(
										"{sharedRecordCount} of them are shared visitor records (owner {owner} in queries).",
										{
											sharedRecordCount: String(snapshot.sharedRecords),
											owner: SHARED_RECORDS_OWNER,
										}
									)}`
								: ""}
						</p>
					) : null}
				</div>
				<div className="flex items-center gap-2">
					{snapshot?.connected ? (
						<Badge variant="outline">Connected to Ryu Spaces</Badge>
					) : null}
					<Button
						disabled={busy || loading}
						onClick={() => void refresh()}
						variant="outline"
					>
						Refresh
					</Button>
				</div>
			</div>
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{loading || snapshot?.connected ? null : (
				<RyuAppEmpty
					description="Connect this Site to a private Ryu Spaces database. Durable visitor records will move there and stay in sync with Spaces."
					title="No database connected"
				/>
			)}
			{snapshot?.connected || loading ? null : (
				<div className="flex justify-end">
					<Button disabled={!available || busy} onClick={() => void connect()}>
						Connect Ryu Spaces database
					</Button>
				</div>
			)}
			{snapshot?.connected ? (
				<div className="grid gap-3">
					<Label htmlFor="site-database-query">SQL query</Label>
					<Textarea
						className="min-h-32 font-mono text-sm"
						id="site-database-query"
						maxLength={8000}
						onChange={(event) => setQuery(event.target.value)}
						spellCheck={false}
						value={query}
					/>
					<div className="flex justify-end">
						<Button
							disabled={querying || !query.trim()}
							onClick={() => void runQuery()}
						>
							{querying ? "Running…" : "Run query"}
						</Button>
					</div>
					{result ? (
						<>
							{result.schema.length ? (
								<div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
									{result.schema.map((column) => (
										<span key={column.id}>
											{column.label}: <code>{column.name}</code>
										</span>
									))}
								</div>
							) : null}
							<p className="text-muted-foreground text-xs" role="status">
								{result.truncated
									? tl("{rowCount} rows · result limited", {
											rowCount: String(result.rows.length),
										})
									: tl("{rowCount} rows", {
											rowCount: String(result.rows.length),
										})}
							</p>
							<div className="max-h-80 overflow-auto rounded-md border">
								<table className="w-full text-left text-sm" data-ryu-i18n="off">
									<thead className="sticky top-0 bg-muted">
										<tr>
											{result.columns.map((column, index) => (
												<th
													className="px-3 py-2 font-medium"
													key={`${column}-${index}`}
												>
													{column}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{result.rows.map((row, rowIndex) => (
											<tr className="border-t" key={rowIndex}>
												{result.columns.map((column, columnIndex) => {
													const value = row[columnIndex] ?? null;
													const displayValue = z.string().safeParse(value)
														.success
														? z.string().parse(value)
														: showValue(value);
													return (
														<td
															aria-label={displayValue}
															className="max-w-80 break-words px-3 py-2 align-top"
															key={`${column}-${columnIndex}`}
														>
															<span className="whitespace-pre-wrap">
																{displayValue}
															</span>
														</td>
													);
												})}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</>
					) : null}
				</div>
			) : null}
		</RyuAppSection>
	);
}
