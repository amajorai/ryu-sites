import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePluginKeys } from "@ryu/sidecar-runtime/seal";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import { createLocalSitesDatabase } from "./local-database.ts";
import { createStandaloneScanner } from "./secret-scan.ts";
import {
	createSitesServer,
	type ServerOptions,
	SITES_SERVICE_VERSION,
} from "./server.ts";
import { runtimeSiteSchema } from "./site-records.ts";
import { SitesStore } from "./store.ts";
import { starterHtml } from "./templates.ts";

const API_TOKEN = "standalone-test-token-0123456789abcdef";
const workDir = mkdtempSync(join(tmpdir(), "ryu-sites-standalone-"));
const cleanup: (() => void)[] = [];
afterAll(() => {
	// Last in, first out: a test registers its folder before the harness that
	// opens a database inside it, and Windows cannot remove an open file.
	for (const close of cleanup.splice(0).reverse()) {
		close();
	}
	rmSync(workDir, { recursive: true, force: true });
});

const visitorIdentity = async (
	request: Request
): Promise<SitePrincipal | null> =>
	request.headers.get("authorization") === "Bearer visitor-a"
		? { id: "visitor-a", email: "a@example.com", workspaceIds: [] }
		: null;

function standalone(
	options: Partial<ServerOptions> = {},
	store = new SitesStore(":memory:")
) {
	const server = createSitesServer({
		store,
		token: API_TOKEN,
		mode: "standalone",
		port: 0,
		visitorPort: 0,
		publicEnabled: true,
		services: {
			identity: visitorIdentity,
			scanArtifact: createStandaloneScanner({ gateway: null }),
			spacesDatabase: createLocalSitesDatabase({
				db: store.db,
				workDir,
				seal: store.seal,
			}),
		},
		...options,
	});
	cleanup.push(() => {
		server.stop();
		store.close();
	});
	const admin = (
		path: string,
		method = "GET",
		body?: SiteDataValue,
		token = API_TOKEN
	) =>
		fetch(`http://127.0.0.1:${server.admin.port}/api/sites${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const visitor = (
		slug: string,
		path: string,
		method = "GET",
		body?: SiteDataValue
	) =>
		fetch(`http://127.0.0.1:${server.visitor.port}${path}`, {
			method,
			headers: {
				host: `${slug}.localhost:${server.visitor.port}`,
				origin: `http://${slug}.localhost:${server.visitor.port}`,
				authorization: "Bearer visitor-a",
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { store, server, admin, visitor };
}

async function parsed(response: Response): Promise<RuntimeSite> {
	if (!response.ok) {
		throw new Error(`${response.status} ${await response.text()}`);
	}
	return runtimeSiteSchema.parse(await response.json());
}

async function createSaved(h: ReturnType<typeof standalone>, html: string) {
	const site = await parsed(
		await h.admin("/projects", "POST", { name: "Docs", slug: "docs-site" })
	);
	return parsed(
		await h.admin(`/projects/${site.id}/versions`, "POST", {
			html,
			expectedRevision: site.revision,
		})
	);
}

describe("standalone Sites management", () => {
	test("describes the service at its home unless a dashboard is configured", async () => {
		for (const dashboardUrl of [undefined, null, "", "   "]) {
			const h = standalone({ dashboardUrl });
			const home = await fetch(`http://127.0.0.1:${h.server.admin.port}/`, {
				redirect: "manual",
			});
			expect(home.status).toBe(200);
			expect(home.headers.get("location")).toBeNull();
			expect(home.headers.get("cache-control")).toBe("no-store");
			expect(await home.json()).toEqual({
				name: "ryu-sites",
				version: SITES_SERVICE_VERSION,
				health: "/health",
			});
		}
		expect(SITES_SERVICE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("redirects the home only to an operator-configured dashboard", async () => {
		const custom = standalone({ dashboardUrl: "https://example.com/org" });
		const overridden = await fetch(
			`http://127.0.0.1:${custom.server.admin.port}/`,
			{ redirect: "manual" }
		);
		expect(overridden.status).toBe(307);
		expect(overridden.headers.get("location")).toBe("https://example.com/org");
		expect(overridden.headers.get("cache-control")).toBe("no-store");
	});

	test("keeps the Core-managed home behind the bearer", async () => {
		const store = new SitesStore(":memory:");
		const server = createSitesServer({
			store,
			token: "core-token",
			port: 0,
			visitorPort: 0,
		});
		cleanup.push(() => {
			server.stop();
			store.close();
		});
		const home = await fetch(`http://127.0.0.1:${server.admin.port}/`, {
			redirect: "manual",
		});
		expect(home.status).toBe(401);
	});

	test("accepts only the standalone bearer and reports standalone status", async () => {
		const h = standalone();
		expect((await h.admin("/status", "GET", undefined, "wrong")).status).toBe(
			401
		);
		const status = await h.admin("/status");
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({
			apiVersion: "v1",
			mode: "standalone",
			scannerAvailable: true,
			databaseAvailable: true,
			retrievalAvailable: false,
			agentAvailable: false,
		});
	});

	test("never lets a visitor session manage Sites", async () => {
		const h = standalone();
		// The fake visitor identity accepts this credential on any listener.
		const asVisitor = await h.admin(
			"/projects",
			"POST",
			{
				name: "Visitor",
				slug: "visitor-site",
			},
			"visitor-a"
		);
		expect(asVisitor.status).toBe(401);
		expect(await (await h.admin("/projects")).json()).toEqual([]);
		const store = new SitesStore(":memory:");
		const core = createSitesServer({
			store,
			token: "core-token",
			port: 0,
			visitorPort: 0,
			services: { identity: visitorIdentity },
		});
		cleanup.push(() => {
			core.stop();
			store.close();
		});
		const coreVisitor = await fetch(
			`http://127.0.0.1:${core.admin.port}/api/sites/projects`,
			{ headers: { authorization: "Bearer visitor-a" } }
		);
		expect(coreVisitor.status).toBe(200);
	});

	test("deploys a clean Site with the built-in scanner", async () => {
		const h = standalone();
		const site = await createSaved(
			h,
			starterHtml("Docs", "website", "Standalone docs")
		);
		const security = await h.admin(`/projects/${site.id}/security`);
		expect(await security.json()).toMatchObject({ status: "passed" });
		const deployed = await parsed(
			await h.admin(`/projects/${site.id}/deploy`, "POST", {
				versionId: site.versions.at(-1)?.id,
				expectedRevision: site.revision,
			})
		);
		expect(deployed.deploymentId).toBe(site.versions.at(-1)?.id ?? null);
		// A private Site serves only its owner, who has no visitor sign-in here.
		expect((await h.visitor(site.slug, "/")).status).toBe(403);
		await parsed(
			await h.admin(`/projects/${site.id}/settings`, "PUT", {
				settings: { ...deployed.settings, audience: "public" },
				expectedRevision: deployed.revision,
			})
		);
		const page = await h.visitor(site.slug, "/");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Standalone docs");
	});

	test("blocks a secret-bearing Site", async () => {
		const h = standalone();
		const fakeKey = `AKIA${"ABCDEFGHIJKLMNOP"}`;
		const site = await createSaved(
			h,
			`<!doctype html><script>const key = "${fakeKey}";</script>`
		);
		const deploy = await h.admin(`/projects/${site.id}/deploy`, "POST", {
			versionId: site.versions.at(-1)?.id,
			expectedRevision: site.revision,
		});
		expect(deploy.status).toBe(422);
		expect(await deploy.json()).toMatchObject({
			error: { code: "security_blocked" },
		});
		const current = await parsed(await h.admin(`/projects/${site.id}`));
		expect(current.deploymentId).toBeNull();
	});

	test("names the OpenID Connect settings when sign-in is not configured", async () => {
		const services = (store: SitesStore) => ({
			scanArtifact: createStandaloneScanner({ gateway: null }),
			spacesDatabase: createLocalSitesDatabase({ db: store.db, workDir }),
		});
		const signInMessages = async (mode: ServerOptions["mode"]) => {
			const store = new SitesStore(":memory:");
			const h = standalone({ store, mode, services: services(store) });
			cleanup.push(() => store.close());
			const site = await createSaved(h, starterHtml("Docs", "website", "Hi"));
			const connected = await parsed(
				await h.admin(`/projects/${site.id}/database/connect`, "POST", {
					expectedRevision: site.revision,
				})
			);
			const messages: string[] = [];
			for (const change of [
				{ audience: "invited", viewers: ["ada@example.com"] },
				{ audience: "workspace" },
				{ optionalSignIn: true },
				{ editors: ["ada@example.com"] },
				{
					mode: "connected",
					sharedData: { ...connected.settings.sharedData, enabled: true },
				},
			]) {
				const response = await h.admin(`/projects/${site.id}/settings`, "PUT", {
					settings: { ...connected.settings, ...change },
					expectedRevision: connected.revision,
				});
				expect(response.status).toBe(503);
				const { error } = (await response.json()) as {
					error: { code: string; message: string };
				};
				expect(error.code).toBe("unavailable");
				messages.push(error.message);
			}
			return messages;
		};
		const standaloneMessages = await signInMessages("standalone");
		expect(standaloneMessages.at(-1)).toContain("shared data");
		for (const message of standaloneMessages) {
			expect(message).toContain("RYU_SITES_ISSUER");
			expect(message).toContain("RYU_SITES_CLIENT_ID");
			expect(message).not.toContain("platform identity");
		}
		// Core connects platform identity itself, so its wording is unchanged.
		for (const message of await signInMessages(undefined)) {
			expect(message).toContain("Connect platform identity");
			expect(message).not.toContain("RYU_SITES_ISSUER");
		}
	});

	test("keeps durable visitor records in the local database", async () => {
		const h = standalone();
		let site = await createSaved(h, starterHtml("Docs", "website", "Records"));
		site = await parsed(
			await h.admin(`/projects/${site.id}/database/connect`, "POST", {
				expectedRevision: site.revision,
			})
		);
		expect(site.settings.database).toEqual({
			spaceId: "local",
			databaseId: site.id,
		});
		site = await parsed(
			await h.admin(`/projects/${site.id}/settings`, "PUT", {
				settings: {
					...site.settings,
					audience: "public",
					mode: "connected",
					storage: true,
				},
				expectedRevision: site.revision,
			})
		);
		site = await parsed(
			await h.admin(`/projects/${site.id}/deploy`, "POST", {
				versionId: site.versions.at(-1)?.id,
				expectedRevision: site.revision,
			})
		);
		const saved = await h.visitor(
			site.slug,
			"/_ryu/records/notes/first",
			"PUT",
			{ text: "hello" }
		);
		expect(saved.status).toBe(200);
		expect(
			await (await h.visitor(site.slug, "/_ryu/records/notes")).json()
		).toEqual([{ key: "first", value: { text: "hello" } }]);
		expect(
			await (await h.admin(`/projects/${site.id}/database`)).json()
		).toMatchObject({ connected: true, records: 1 });
		const query = await h.admin(`/projects/${site.id}/database/query`, "POST", {
			query: "SELECT owner, collection, key FROM data",
		});
		expect(await query.json()).toMatchObject({
			columns: ["owner", "collection", "key"],
			rows: [["visitor-a", "notes", "first"]],
		});
		expect(
			(await h.visitor(site.slug, "/_ryu/records/notes/first", "DELETE")).status
		).toBe(200);
		expect(
			await (await h.visitor(site.slug, "/_ryu/records/notes")).json()
		).toEqual([]);
		await h.visitor(site.slug, "/_ryu/records/notes/again", "PUT", {
			text: "kept until delete",
		});
		const removed = await h.admin(`/projects/${site.id}`, "DELETE", {
			slug: site.slug,
			expectedRevision: site.revision,
		});
		expect(removed.status).toBe(200);
		expect(
			h.store.db
				.query("SELECT COUNT(*) AS count FROM site_database_records")
				.get()
		).toEqual({ count: 0 });
	});

	test("seals uploads, names, records and Site state on disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-sites-sealed-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "sites.sqlite");
		const keys = capturePluginKeys("@ryu/sites", {
			RYU_SEAL_KEY: Buffer.from(new Uint8Array(32).fill(4)).toString("base64"),
			RYU_SEAL_SCOPE: "plugin:@ryu/sites",
		});
		const store = new SitesStore(path, { keys });
		const h = standalone({}, store);
		let site = await createSaved(h, starterHtml("Docs", "website", "Records"));
		site = await parsed(
			await h.admin(`/projects/${site.id}/database/connect`, "POST", {
				expectedRevision: site.revision,
			})
		);
		site = await parsed(
			await h.admin(`/projects/${site.id}/settings`, "PUT", {
				settings: {
					...site.settings,
					audience: "public",
					mode: "connected",
					storage: true,
					uploads: true,
					viewers: ["viewer-secret@example.com"],
				},
				expectedRevision: site.revision,
			})
		);
		site = await parsed(
			await h.admin(`/projects/${site.id}/deploy`, "POST", {
				versionId: site.versions.at(-1)?.id,
				expectedRevision: site.revision,
			})
		);
		await h.visitor(site.slug, "/_ryu/records/notes/first", "PUT", {
			text: "record-secret-text",
		});
		const upload = await h.visitor(site.slug, "/_ryu/files", "POST", {
			name: "upload-secret-name.txt",
			data: btoa("upload-secret-bytes"),
		});
		expect(upload.status).toBe(201);
		const { id } = (await upload.json()) as { id: string };
		const download = await h.visitor(site.slug, `/_ryu/files/${id}`);
		expect(await download.text()).toBe("upload-secret-bytes");
		expect(
			await (await h.visitor(site.slug, "/_ryu/records/notes/first")).json()
		).toEqual([{ key: "first", value: { text: "record-secret-text" } }]);
		const listed = await (
			await h.admin(`/projects/${site.id}/visitors`)
		).json();
		// Quotas count the plaintext size, not the sealed length.
		expect(listed.visitors).toMatchObject([
			{ owner: "visitor-a", files: 1, fileBytes: 19, records: 1 },
		]);
		const status = await (await h.admin("/status")).json();
		expect(status.sealing).toMatchObject({ sealing: "ok", state: "record" });
		const row = store.db
			.query("SELECT name, data, size FROM files WHERE id=?")
			.get(id) as { data: Uint8Array; name: string; size: number };
		expect(row.name.startsWith("encb:v1:")).toBe(true);
		expect(Buffer.from(row.data).subarray(0, 8).toString()).toBe("RYU-CB01");
		expect(row.size).toBe(19);
		store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		let disk = readFileSync(path).toString("latin1");
		try {
			disk += readFileSync(`${path}-wal`).toString("latin1");
		} catch {
			// No WAL.
		}
		for (const secret of [
			"viewer-secret@example.com",
			"record-secret-text",
			"upload-secret-name",
			"upload-secret-bytes",
		]) {
			expect(disk).not.toContain(secret);
		}
	});

	test("lets the bearer list and purge one visitor's local data", async () => {
		const h = standalone();
		let site = await createSaved(h, starterHtml("Docs", "website", "Records"));
		site = await parsed(
			await h.admin(`/projects/${site.id}/database/connect`, "POST", {
				expectedRevision: site.revision,
			})
		);
		site = await parsed(
			await h.admin(`/projects/${site.id}/settings`, "PUT", {
				settings: {
					...site.settings,
					audience: "public",
					mode: "connected",
					storage: true,
					uploads: true,
				},
				expectedRevision: site.revision,
			})
		);
		site = await parsed(
			await h.admin(`/projects/${site.id}/deploy`, "POST", {
				versionId: site.versions.at(-1)?.id,
				expectedRevision: site.revision,
			})
		);
		await h.visitor(site.slug, "/_ryu/records/notes/first", "PUT", {
			text: "hello",
		});
		const upload = await h.visitor(site.slug, "/_ryu/files", "POST", {
			name: "note.txt",
			data: btoa("hello"),
		});
		expect(upload.status).toBe(201);
		const listed = await (
			await h.admin(`/projects/${site.id}/visitors`)
		).json();
		expect(listed.visitors).toMatchObject([
			{ owner: "visitor-a", files: 1, fileBytes: 5, records: 1 },
		]);
		expect(
			(
				await h.admin(
					`/projects/${site.id}/visitors/${listed.visitors[0].visitor}/data`,
					"DELETE",
					undefined,
					"wrong-token-0123456789abcdefghijklmnop"
				)
			).status
		).toBe(401);
		const purged = await h.admin(
			`/projects/${site.id}/visitors/${listed.visitors[0].visitor}/data`,
			"DELETE"
		);
		expect(await purged.json()).toMatchObject({
			deleted: { files: 1, fileBytes: 5, records: 1 },
		});
		const after = await (await h.admin(`/projects/${site.id}/visitors`)).json();
		expect(after.visitors).toEqual([]);
		expect(after.audit).toMatchObject([
			{ action: "visitor_data.delete", files: 1, records: 1 },
		]);
		expect(
			h.store.db
				.query("SELECT COUNT(*) AS count FROM site_database_records")
				.get()
		).toEqual({ count: 0 });
	});
});
