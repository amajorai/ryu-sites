import { afterEach, expect, test } from "bun:test";
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
const { formatStoredSize, SiteVisitorDataPanel } = await import(
	"./visitor-data-panel.tsx"
);

interface Request {
	body?: SiteDataValue;
	method: string;
	path: string;
}
const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => {
			root.unmount();
			await flush();
		});
		container.remove();
	}
	Reflect.set(window, "ryu", undefined);
});

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const site: RuntimeSite = {
	id: "site-1",
	name: "Site",
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
	settings: siteSettings.parse({ mode: "connected", storage: true }),
	slug: "site-one",
	template: "website",
	versions: [],
};
const visitor = {
	visitor: "dmlzaXRvci1h",
	owner: "visitor-a",
	files: 2,
	fileBytes: 2048,
	records: 3,
	recordBytes: 300,
};
const auditEntry = {
	action: "visitor_data.delete",
	actor: "owner",
	at: "2026-10-11T08:00:00.000Z",
	visitor: "0123456789abcdef",
	files: 2,
	fileBytes: 2048,
	records: 3,
};

function bridge(responses: ((request: Request) => SiteDataValue)[]) {
	const calls: Request[] = [];
	Reflect.set(window, "ryu", {
		app: {
			request: async (input: Request) => {
				calls.push({ method: input.method, path: input.path });
				const next = responses.shift();
				if (!next) {
					throw new Error(`Unexpected request ${input.method} ${input.path}`);
				}
				return next(input);
			},
		},
	});
	return calls;
}

async function render() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => {
		root.render(<SiteVisitorDataPanel site={site} />);
		await flush();
	});
	return container;
}

async function click(label: string) {
	const found = [...document.body.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}`);
	}
	await act(async () => {
		found.click();
		await flush();
	});
}

test("formats stored sizes in bytes, KB and MB", () => {
	expect(formatStoredSize(512)).toBe("512 B");
	expect(formatStoredSize(2048)).toBe("2 KB");
	expect(formatStoredSize(1_572_864)).toBe("1.5 MB");
});

test("the owner confirms and purges one visitor's data, then sees the audit entry", async () => {
	const calls = bridge([
		() => ({ visitors: [visitor], audit: [] }),
		() => ({
			visitor: visitor.visitor,
			deleted: { files: 2, fileBytes: 2048, records: 3 },
		}),
		() => ({ visitors: [], audit: [auditEntry] }),
	]);
	const container = await render();
	expect(container.textContent).toContain("visitor-a");
	expect(container.textContent).toContain("2 KB");
	await click("Delete data");
	expect(document.body.textContent).toContain(
		"3 records and 2 files (2.3 KB) saved by visitor-a will be permanently deleted"
	);
	await click("Delete permanently");
	expect(calls).toEqual([
		{ method: "GET", path: "/projects/site-1/visitors" },
		{ method: "DELETE", path: "/projects/site-1/visitors/dmlzaXRvci1h/data" },
		{ method: "GET", path: "/projects/site-1/visitors" },
	]);
	expect(container.querySelector('[role="status"]')?.textContent).toBe(
		"Deleted 3 records and 2 files."
	);
	expect(container.textContent).toContain("No visitor data");
	expect(container.textContent).toContain("0123456789abcdef");
});

test("a refused purge keeps the visitor listed and shows the service error", async () => {
	bridge([
		() => ({ visitors: [visitor], audit: [] }),
		() => {
			throw new Error("Ryu Spaces database access is unavailable");
		},
	]);
	const container = await render();
	await click("Delete data");
	await click("Delete permanently");
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"Ryu Spaces database access is unavailable"
	);
	expect(container.textContent).toContain("visitor-a");
});

test("an unavailable listing is reported instead of an empty state", async () => {
	bridge([
		() => {
			throw new Error("Visitor records could not be read");
		},
	]);
	const container = await render();
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"Visitor records could not be read"
	);
	expect(container.textContent).not.toContain("No visitor data");
});
