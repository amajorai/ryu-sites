import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { type RuntimeSite, siteSettings } from "../../sidecar/src/contracts.ts";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SiteDatabasePanel } = await import("./database-panel.tsx");

interface Request {
	body?: SiteDataValue;
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
}
interface Step {
	request: Request;
	response: SiteDataValue | Promise<SiteDataValue>;
}
const mounted: { root: Root; container: HTMLDivElement }[] = [];
const unexpected: string[] = [];
const cleanupPending: (() => void)[] = [];
const runtimeErrors: string[] = [];
const recordError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const recordRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

beforeEach(() => {
	window.addEventListener("error", recordError);
	window.addEventListener("unhandledrejection", recordRejection);
});

function deferred() {
	let resolve!: (value: SiteDataValue) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<SiteDataValue>((fulfill, refuse) => {
		resolve = fulfill;
		reject = refuse;
	});
	cleanupPending.push(() => resolve(null));
	return { promise, resolve, reject };
}

function site(id: "a" | "b"): RuntimeSite {
	return {
		id,
		name: `Site ${id.toUpperCase()}`,
		ownerId: "owner",
		access: "owner",
		aliases: [],
		createdAt: "2026-10-05T00:00:00Z",
		updatedAt: "2026-10-05T00:00:00Z",
		deploymentId: null,
		domains: [],
		hasPublished: false,
		prompt: "",
		revision: 1,
		schemaVersion: 1,
		settings: siteSettings.parse({}),
		slug: `site-${id}`,
		template: "dashboard",
		versions: [],
	};
}
const snapshot = (records: number) => ({ connected: true, records });
const queryResult = (owner: string) => ({
	columns: ["owner"],
	rows: [[owner]],
	schema: [{ id: owner, label: `${owner} schema`, name: "owner" }],
	truncated: false,
});
const get = (id: string): Request => ({
	method: "GET",
	path: `/projects/${id}/database`,
});
const query = (id: string): Request => ({
	method: "POST",
	path: `/projects/${id}/database/query`,
	body: { query: "SELECT * FROM data LIMIT 100" },
});

function bridge(steps: Step[]) {
	const calls: Request[] = [];
	Reflect.set(window, "ryu", {
		app: {
			request: async (input: Request) => {
				const recorded: Request = { method: input.method, path: input.path };
				if (input.body !== undefined) {
					recorded.body = input.body;
				}
				calls.push(recorded);
				const expected = steps[calls.length - 1];
				if (
					!expected ||
					JSON.stringify(recorded) !== JSON.stringify(expected.request)
				) {
					const message = `Unexpected Sites request ${JSON.stringify(recorded)}; expected ${JSON.stringify(expected?.request)}`;
					unexpected.push(message);
					throw new Error(message);
				}
				return expected.response;
			},
		},
	});
	return calls;
}

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	return { root, container };
}
async function select(root: Root, selected: RuntimeSite) {
	// App renders this production panel without a site key. Preserve that actual
	// reuse boundary; no replacement SQL state model or fake selection buttons.
	await act(async () => {
		root.render(
			<SiteDatabasePanel
				available
				busy={false}
				replace={() => {
					throw new Error("Unexpected database connect/write");
				}}
				run={async (work) => work()}
				site={selected}
			/>
		);
		await flush();
	});
}
function button(container: HTMLElement, label: string) {
	const found = [...container.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing actual Sites button ${label}`);
	}
	return found;
}
async function click(container: HTMLElement, label: string) {
	await act(async () => {
		button(container, label).click();
		await flush();
	});
}
async function release(work: () => void) {
	await act(async () => {
		work();
		await flush();
	});
}

afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => {
			root.unmount();
			await flush();
		});
		container.remove();
	}
	for (const finish of cleanupPending.splice(0)) {
		finish();
	}
	Reflect.set(window, "ryu", undefined);
	window.removeEventListener("error", recordError);
	window.removeEventListener("unhandledrejection", recordRejection);
	const failures = [...unexpected.splice(0), ...runtimeErrors.splice(0)];
	if (failures.length) {
		throw new Error(failures.join("\n"));
	}
});

for (const outcome of ["success", "error"] as const) {
	test(`old Site A SQL ${outcome} cannot publish into Site B or unlock its pending query`, async () => {
		const old = deferred();
		const current = deferred();
		const steps: Step[] = [
			{ request: get("a"), response: snapshot(2) },
			{ request: query("a"), response: old.promise },
			{ request: get("b"), response: snapshot(7) },
			{ request: query("b"), response: current.promise },
		];
		const calls = bridge(steps);
		const { root, container } = await mount();
		await select(root, site("a"));
		await click(container, "Run query");
		expect(button(container, "Running…").disabled).toBe(true);
		await select(root, site("b"));
		expect(container.textContent).toContain("7 records in this Site database");
		expect(
			[...container.querySelectorAll("button")].some(
				(node) => node.textContent?.trim() === "Running…"
			)
		).toBe(false);
		expect(button(container, "Run query").disabled).toBe(false);
		await click(container, "Run query");
		expect(calls).toEqual(steps.map((step) => step.request));
		await release(() =>
			outcome === "success"
				? old.resolve(queryResult("PRIVATE_A"))
				: old.reject(new Error("Old A query refused"))
		);
		expect(button(container, "Running…").disabled).toBe(true);
		expect(container.querySelector("table")).toBeNull();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).not.toContain("PRIVATE_A");
		await release(() => current.resolve(queryResult("CURRENT_B")));
		expect(container.querySelector("table")?.textContent).toContain(
			"CURRENT_B"
		);
		expect(container.textContent).toContain("CURRENT_B schema");
		expect(container.textContent).not.toContain("PRIVATE_A");
		expect(button(container, "Run query").disabled).toBe(false);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(calls).toEqual(steps.map((step) => step.request));
	});

	test(`old Site A manual-refresh ${outcome} cannot replace Site B connection or finish its refresh`, async () => {
		const old = deferred();
		const current = deferred();
		const steps: Step[] = [
			{ request: get("a"), response: snapshot(2) },
			{ request: get("a"), response: old.promise },
			{ request: get("b"), response: snapshot(7) },
			{ request: query("b"), response: queryResult("CURRENT_B") },
			{ request: get("b"), response: current.promise },
		];
		const calls = bridge(steps);
		const { root, container } = await mount();
		await select(root, site("a"));
		await click(container, "Refresh");
		await select(root, site("b"));
		await click(container, "Run query");
		expect(container.querySelector("table")?.textContent).toContain(
			"CURRENT_B"
		);
		await click(container, "Refresh");
		expect(button(container, "Refresh").disabled).toBe(true);
		await release(() =>
			outcome === "success"
				? old.resolve({ connected: false, records: 9999 })
				: old.reject(new Error("Old A refresh refused"))
		);
		expect(button(container, "Refresh").disabled).toBe(true);
		expect(container.textContent).toContain("Checking database connection…");
		expect(container.querySelector("table")?.textContent).toContain(
			"CURRENT_B"
		);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).not.toContain("No database connected");
		await release(() => current.resolve(snapshot(8)));
		expect(container.textContent).toContain("8 records in this Site database");
		expect(container.querySelector("table")?.textContent).toContain(
			"CURRENT_B"
		);
		expect(button(container, "Refresh").disabled).toBe(false);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(calls).toEqual(steps.map((step) => step.request));
	});
}

test("the current Site SQL refusal stays actionable and explicit retry uses the same query", async () => {
	const refused = deferred();
	const steps: Step[] = [
		{ request: get("b"), response: snapshot(7) },
		{ request: query("b"), response: refused.promise },
		{ request: query("b"), response: queryResult("RETRY_B") },
	];
	const calls = bridge(steps);
	const { root, container } = await mount();
	await select(root, site("b"));
	await click(container, "Run query");
	await release(() => refused.reject(new Error("Query permission denied")));
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"Query permission denied"
	);
	expect(container.querySelector("table")).toBeNull();
	expect(container.querySelector("textarea")?.value).toBe(
		"SELECT * FROM data LIMIT 100"
	);
	expect(button(container, "Run query").disabled).toBe(false);
	expect(calls).toEqual(steps.slice(0, 2).map((step) => step.request));
	await click(container, "Run query");
	expect(container.querySelector("table")?.textContent).toContain("RETRY_B");
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(calls).toEqual(steps.map((step) => step.request));
});

test("the current Site refresh refusal keeps existing results and only an explicit refresh retries", async () => {
	const refused = deferred();
	const steps: Step[] = [
		{ request: get("b"), response: snapshot(7) },
		{ request: query("b"), response: queryResult("CURRENT_B") },
		{ request: get("b"), response: refused.promise },
		{ request: get("b"), response: snapshot(8) },
	];
	const calls = bridge(steps);
	const { root, container } = await mount();
	await select(root, site("b"));
	await click(container, "Run query");
	await click(container, "Refresh");
	await release(() => refused.reject(new Error("Database refresh denied")));
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"Database refresh denied"
	);
	expect(container.querySelector("table")?.textContent).toContain("CURRENT_B");
	expect(button(container, "Refresh").disabled).toBe(false);
	expect(calls).toEqual(steps.slice(0, 3).map((step) => step.request));
	await click(container, "Refresh");
	expect(container.textContent).toContain("8 records in this Site database");
	expect(container.querySelector("table")?.textContent).toContain("CURRENT_B");
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(calls).toEqual(steps.map((step) => step.request));
});
