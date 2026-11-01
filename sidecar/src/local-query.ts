import { z } from "zod";
import { type SiteDataValue, siteDataValueSchema } from "./data-values.ts";
import type { SiteDatabaseQueryResult } from "./spaces-database.ts";
import { SiteError } from "./store.ts";

/** Wall-clock budget for one SQL console query, including the helper's start. */
export const LOCAL_QUERY_TIMEOUT_MS = 3000;
const MAX_QUERY_BYTES = 8000;
const MAX_PARAMETERS = 64;
const MAX_HELPER_OUTPUT_BYTES = 4_000_000;
/** How far one statement may grow the helper's resident memory. */
const MAX_HELPER_GROWTH_BYTES = 256 * 1024 * 1024;
const QUERY_SCHEMA = [
	{ id: "owner", label: "Owner", name: "owner" },
	{ id: "collection", label: "Collection", name: "collection" },
	{ id: "key", label: "Key", name: "key" },
	{ id: "value", label: "Value", name: "value" },
];

/**
 * Runs in a short-lived helper process so a runaway query can be killed. Bun's
 * SQLite binding cannot interrupt a statement, and a thread cannot be stopped
 * mid-statement. The helper sees only the Site's own rows on stdin, keeps temp
 * storage in memory (a sort never spills decrypted rows to disk), caps the
 * statement's memory, locks the copy read-only and bounds the result like Ryu
 * Spaces.
 *
 * Bun's SQLite does not enforce `hard_heap_limit`, so a watchdog thread
 * enforces the memory cap instead: once the statement grows the
 * process past its budget, the watchdog reports the refusal and kills the
 * process mid-statement. The pragma stays for SQLite builds that honor it.
 */
const QUERY_HELPER = `const { Database } = require("bun:sqlite");
const watchdog = new Worker(URL.createObjectURL(new Blob([
	"const { writeSync } = require('node:fs');" +
	"onmessage = (event) => { setInterval(() => { if (process.memoryUsage().rss > event.data) {" +
	" writeSync(1, JSON.stringify({ ok: false, error: 'the query needs more memory than the SQL console allows' }));" +
	" process.kill(process.pid, 'SIGKILL'); } }, 2); postMessage('armed'); };"
])));
const write = (value) => { watchdog.terminate(); process.stdout.write(JSON.stringify(value)); };
try {
	const input = JSON.parse(await Bun.stdin.text());
	const db = new Database(":memory:");
	// Bun's SQLite defaults temp storage to files: a large sort would spill the
	// decrypted rows to an unlinked temp file. Keep it in the capped memory.
	db.exec("PRAGMA temp_store=MEMORY");
	db.exec('CREATE TABLE data ("owner", "collection", "key", "value")');
	const insert = db.prepare("INSERT INTO data VALUES (?, ?, ?, ?)");
	db.transaction(() => { for (const row of input.rows) insert.run(row[0], row[1], row[2], row[3]); })();
	db.exec("PRAGMA hard_heap_limit=67108864");
	db.exec("PRAGMA query_only=ON");
	// The budget counts from here, so a Site with many rows keeps its full share.
	await new Promise((armed) => {
		watchdog.onmessage = armed;
		watchdog.postMessage(process.memoryUsage().rss + ${MAX_HELPER_GROWTH_BYTES});
	});
	const statement = db.prepare(input.statement);
	const columns = statement.columnNames;
	// Bun 1.3 de-duplicates columnNames (SELECT 1 AS a, 2 AS a gives ["a"]), so the
	// real column count comes from declaredTypes, which has one entry per column.
	// Bun 1.4 keeps every name but refuses declaredTypes before the first step.
	let columnCount = columns.length;
	try { columnCount = statement.declaredTypes.length; } catch {}
	if (columnCount > 128) throw new Error("query returns too many columns");
	if (columnCount !== columns.length || new Set(columns).size !== columns.length) throw new Error("give each result column a distinct name with AS");
	const rows = [];
	let bytes = 0;
	let truncated = false;
	for (const record of statement.iterate(...input.parameters)) {
		if (rows.length >= 500) { truncated = true; break; }
		// A lower bound on the row's JSON size, checked before converting a BLOB
		// into an array, so one huge value is refused without burning the budget.
		let floor = 0;
		for (const name of columns) {
			const value = record[name];
			floor += value instanceof Uint8Array ? value.byteLength * 2 : typeof value === "string" ? value.length : 0;
		}
		if (bytes + floor > 1048576) { truncated = true; break; }
		const row = columns.map((name) => {
			const value = record[name];
			if (value instanceof Uint8Array) return Array.from(value);
			if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
			return value ?? null;
		});
		const size = JSON.stringify(row).length;
		if (bytes + size > 1048576) { truncated = true; break; }
		bytes += size;
		rows.push(row);
	}
	write({ ok: true, columns, rows, truncated });
} catch (error) {
	write({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
}`;

const helperResult = z.union([
	z.object({
		ok: z.literal(true),
		columns: z.array(z.string()),
		rows: z.array(z.array(siteDataValueSchema)),
		truncated: z.boolean(),
	}),
	z.object({ ok: z.literal(false), error: z.string() }),
]);

function startsWithSelect(query: string): boolean {
	let rest = query.trimStart();
	while (true) {
		if (rest.startsWith("--")) {
			const end = rest.indexOf("\n");
			rest = end < 0 ? "" : rest.slice(end + 1).trimStart();
			continue;
		}
		if (rest.startsWith("/*")) {
			const end = rest.indexOf("*/");
			if (end < 0) {
				return false;
			}
			rest = rest.slice(end + 2).trimStart();
			continue;
		}
		break;
	}
	const keyword = /^[A-Za-z]*/.exec(rest)?.[0]?.toLowerCase() ?? "";
	return keyword === "select" || keyword === "with";
}

type QuoteState =
	| "none"
	| "single"
	| "double"
	| "backtick"
	| "bracket"
	| "line"
	| "block";

const OPENERS = new Map<string, QuoteState>([
	["'", "single"],
	['"', "double"],
	["`", "backtick"],
	["[", "bracket"],
]);

/** Counts statements outside quotes and comments, like Ryu Spaces. */
function hasMultipleStatements(query: string): boolean {
	let state: QuoteState = "none";
	let statements = 0;
	let content = false;
	for (let index = 0; index < query.length; index += 1) {
		const char = query[index] ?? "";
		const next = query[index + 1];
		if (state === "none") {
			if (char === "-" && next === "-") {
				state = "line";
				index += 1;
			} else if (char === "/" && next === "*") {
				state = "block";
				index += 1;
			} else if (OPENERS.has(char)) {
				state = OPENERS.get(char) ?? "none";
				content = true;
			} else if (char === ";") {
				if (content) {
					statements += 1;
					content = false;
				}
			} else if (!/\s/.test(char)) {
				content = true;
			}
			continue;
		}
		const closesDoubled =
			(state === "single" && char === "'") ||
			(state === "double" && char === '"');
		if (closesDoubled) {
			if (next === char) {
				index += 1;
			} else {
				state = "none";
			}
		} else if (
			(state === "backtick" && char === "`") ||
			(state === "bracket" && char === "]") ||
			(state === "line" && char === "\n")
		) {
			state = "none";
		} else if (state === "block" && char === "*" && next === "/") {
			state = "none";
			index += 1;
		}
	}
	return statements + (content ? 1 : 0) > 1;
}

function sqlParameter(value: SiteDataValue): string | number | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "boolean") {
		return value ? 1 : 0;
	}
	if (typeof value === "number" || typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}

async function readLimited(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	onOverflow: () => void
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		size += chunk.value.byteLength;
		if (size > limit) {
			onOverflow();
			await reader.cancel();
			throw new SiteError(
				"invalid_input",
				"The query result exceeds the size limit",
				400
			);
		}
		chunks.push(chunk.value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Refuses anything but one bounded, read-only SELECT before a helper starts. */
export function assertConsoleQuery(
	statement: string,
	parameters: SiteDataValue[]
): void {
	const bytes = new TextEncoder().encode(statement).byteLength;
	if (bytes > MAX_QUERY_BYTES || statement.trim() === "") {
		throw new SiteError(
			"invalid_input",
			`A query must contain 1 to ${MAX_QUERY_BYTES} bytes`
		);
	}
	if (parameters.length > MAX_PARAMETERS) {
		throw new SiteError(
			"invalid_input",
			`A query supports at most ${MAX_PARAMETERS} parameters`
		);
	}
	if (!startsWithSelect(statement) || hasMultipleStatements(statement)) {
		throw new SiteError(
			"invalid_input",
			"Only one read-only SELECT query is allowed"
		);
	}
}

/** Runs one checked console query over the Site's opened rows in a helper. */
export async function runQueryHelper(options: {
	rows: SiteDataValue[][];
	statement: string;
	parameters: SiteDataValue[];
	workDir: string;
	timeoutMs: number;
}): Promise<SiteDatabaseQueryResult> {
	const helper = Bun.spawn([process.execPath, "-e", QUERY_HELPER], {
		cwd: options.workDir,
		// A minimal environment: the helper needs no secrets, and inherited
		// BUN_* or NODE_* options must not change how it starts.
		env: { BUN_BE_BUN: "1" },
		stdin: new Blob([
			JSON.stringify({
				rows: options.rows,
				statement: options.statement,
				parameters: options.parameters.map(sqlParameter),
			}),
		]),
		stdout: "pipe",
		stderr: "ignore",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		helper.kill(9);
	}, options.timeoutMs);
	let output: string;
	try {
		output = await readLimited(helper.stdout, MAX_HELPER_OUTPUT_BYTES, () =>
			helper.kill(9)
		);
		await helper.exited;
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) {
		throw new SiteError(
			"query_timeout",
			"The query took too long and was stopped",
			400
		);
	}
	let parsed: z.infer<typeof helperResult>;
	try {
		parsed = helperResult.parse(JSON.parse(output));
	} catch {
		throw new SiteError(
			"query_failed",
			"The query could not be completed",
			400
		);
	}
	if (!parsed.ok) {
		throw new SiteError(
			"invalid_input",
			`The SQL query failed: ${parsed.error}`
		);
	}
	return {
		columns: parsed.columns,
		rows: parsed.rows,
		schema: QUERY_SCHEMA,
		truncated: parsed.truncated,
	};
}
