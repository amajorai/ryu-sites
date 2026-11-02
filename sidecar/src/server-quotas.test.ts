import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarHostError } from "@ryu/sidecar-runtime";
import { z } from "zod";
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import type { SiteDataValue } from "./data-values.ts";
import type { SitesServices } from "./server.ts";
import {
	cleanup,
	create,
	deploy,
	harness,
	publish,
	runCleanup,
	save,
} from "./server-harness.ts";
import { runtimeSiteSchema } from "./site-records.ts";

afterAll(runCleanup);

describe("per-visitor shares of Site-wide quotas", () => {
	const identity = async (request: Request): Promise<SitePrincipal | null> => {
		const auth = request.headers.get("authorization");
		return auth === "Bearer visitor-a" || auth === "Bearer visitor-b"
			? { id: auth, email: `${auth.slice(-1)}@example.com`, workspaceIds: [] }
			: null;
	};
	const connect = async (
		h: ReturnType<typeof harness>,
		patch: Partial<RuntimeSite["settings"]>
	) => {
		let site = await publish(
			h,
			await deploy(h, await save(h, await create(h)))
		);
		const connected = await h.admin(
			`/projects/${site.id}/database/connect`,
			"POST",
			{ expectedRevision: site.revision }
		);
		site = runtimeSiteSchema.parse(await connected.json());
		const updated = await h.admin(`/projects/${site.id}/settings`, "PUT", {
			settings: { ...site.settings, mode: "connected", ...patch },
			expectedRevision: site.revision,
		});
		if (updated.status !== 200) {
			throw new Error(await updated.text());
		}
		return runtimeSiteSchema.parse(await updated.json());
	};

	test("one visitor's uploads cannot use up the Site's file quota", async () => {
		const h = harness({ identity });
		const site = await connect(h, { uploads: true });
		const upload = (visitor: string) =>
			h.visitor(
				site.slug,
				"/_ryu/files",
				"POST",
				{ name: "note.txt", data: btoa("hello") },
				{ authorization: `Bearer ${visitor}` }
			);
		const statuses: number[] = [];
		for (let index = 0; index < 11; index += 1) {
			statuses.push((await upload("visitor-a")).status);
		}
		expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
		const refused = await upload("visitor-a");
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("your upload limit");
		expect((await upload("visitor-b")).status).toBe(201);
	});

	test("the owner lists and purges one visitor's data, freeing their share", async () => {
		const h = harness({ identity });
		const site = await connect(h, { storage: true, uploads: true });
		const as = (visitor: string) => ({ authorization: `Bearer ${visitor}` });
		const upload = (visitor: string) =>
			h.visitor(
				site.slug,
				"/_ryu/files",
				"POST",
				{ name: "note.txt", data: btoa("hello") },
				as(visitor)
			);
		for (let index = 0; index < 10; index += 1) {
			expect((await upload("visitor-a")).status).toBe(201);
		}
		expect((await upload("visitor-a")).status).toBe(429);
		expect((await upload("visitor-b")).status).toBe(201);
		for (const [visitor, key] of [
			["visitor-a", "first"],
			["visitor-a", "second"],
			["visitor-b", "first"],
		] as const) {
			const saved = await h.visitor(
				site.slug,
				`/_ryu/records/notes/${key}`,
				"PUT",
				{ text: key },
				as(visitor)
			);
			expect(saved.status).toBe(200);
		}
		const listing = z.object({
			visitors: z.array(
				z.object({
					visitor: z.string(),
					owner: z.string(),
					files: z.number(),
					fileBytes: z.number(),
					records: z.number(),
					recordBytes: z.number(),
				})
			),
			audit: z.array(
				z.object({
					action: z.string(),
					actor: z.string(),
					at: z.string(),
					visitor: z.string(),
					files: z.number(),
					fileBytes: z.number(),
					records: z.number(),
				})
			),
		});
		const list = async () =>
			listing.parse(
				await (await h.admin(`/projects/${site.id}/visitors`)).json()
			);
		const before = await list();
		expect(
			before.visitors.map(({ owner, files, fileBytes, records }) => ({
				owner,
				files,
				fileBytes,
				records,
			}))
		).toEqual([
			{ owner: "Bearer visitor-a", files: 10, fileBytes: 50, records: 2 },
			{ owner: "Bearer visitor-b", files: 1, fileBytes: 5, records: 1 },
		]);
		expect(before.audit).toEqual([]);
		const target = before.visitors[0]?.visitor ?? "";
		expect(target).toMatch(/^[A-Za-z0-9_-]+$/);

		// Visitors and editors never reach owner tools, and keys must be canonical.
		expect(
			(
				await h.admin(
					`/projects/${site.id}/visitors`,
					"GET",
					undefined,
					"visitor-a"
				)
			).status
		).toBe(403);
		expect(
			(
				await h.admin(
					`/projects/${site.id}/visitors/${target}/data`,
					"DELETE",
					undefined,
					"visitor-a"
				)
			).status
		).toBe(403);
		for (const key of ["not=canonical", "%2F", `${target}=`]) {
			const refused = await h.admin(
				`/projects/${site.id}/visitors/${key}/data`,
				"DELETE"
			);
			expect(refused.status).toBe(400);
		}

		const purged = await h.admin(
			`/projects/${site.id}/visitors/${target}/data`,
			"DELETE"
		);
		expect(purged.status).toBe(200);
		expect(await purged.json()).toMatchObject({
			visitor: target,
			deleted: { files: 10, fileBytes: 50, records: 2 },
		});
		const after = await list();
		expect(after.visitors.map((entry) => entry.owner)).toEqual([
			"Bearer visitor-b",
		]);
		expect(after.audit).toHaveLength(1);
		expect(after.audit[0]).toMatchObject({
			action: "visitor_data.delete",
			actor: "node-owner",
			files: 10,
			fileBytes: 50,
			records: 2,
		});
		expect(after.audit[0]?.visitor).toMatch(/^[a-f0-9]{16}$/);
		expect(
			JSON.stringify(h.store.db.query("SELECT * FROM site_audit").all())
		).not.toContain("visitor-a");
		expect(
			await (
				await h.visitor(
					site.slug,
					"/_ryu/records/notes",
					"GET",
					undefined,
					as("visitor-a")
				)
			).json()
		).toEqual([]);
		expect((await upload("visitor-a")).status).toBe(201);
	});

	test("one visitor's questions cannot use up the Site's daily answers", async () => {
		const h = harness({
			identity,
			answer: async () => ({ text: "grounded", sources: [] }),
			retrieve: async () => [],
			canBindSpace: () => true,
		});
		const site = await connect(h, {
			ai: true,
			aiDailyLimit: 10,
			spaceId: "approved",
		});
		const ask = (visitor: string) =>
			h.visitor(
				site.slug,
				"/_ryu/ask",
				"POST",
				{ query: "What is new?" },
				{ authorization: `Bearer ${visitor}` }
			);
		expect((await ask("visitor-a")).status).toBe(200);
		expect((await ask("visitor-a")).status).toBe(200);
		const refused = await ask("visitor-a");
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("your daily answer limit");
		expect((await ask("visitor-b")).status).toBe(200);
		const stored = h.store.db
			.query("SELECT kind FROM operation_usage WHERE kind != 'answer'")
			.all();
		expect(JSON.stringify(stored)).not.toContain("visitor-a");
	});

	test("a restart keeps each visitor's daily answer share", async () => {
		const directory = mkdtempSync(join(tmpdir(), "sites-answers-"));
		cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
		const path = join(directory, "sites.sqlite");
		const services: SitesServices = {
			identity,
			answer: async () => ({ text: "grounded", sources: [] }),
			retrieve: async () => [],
			canBindSpace: () => true,
		};
		const ask = (
			h: ReturnType<typeof harness>,
			slug: string,
			visitor: string
		) =>
			h.visitor(
				slug,
				"/_ryu/ask",
				"POST",
				{ query: "What is new?" },
				{ authorization: `Bearer ${visitor}` }
			);
		const first = harness(services, true, [], path);
		const site = await connect(first, {
			ai: true,
			aiDailyLimit: 10,
			spaceId: "approved",
		});
		expect((await ask(first, site.slug, "visitor-a")).status).toBe(200);
		expect((await ask(first, site.slug, "visitor-a")).status).toBe(200);
		first.server.stop();
		first.store.close();
		const restarted = harness(services, true, [], path);
		const refused = await ask(restarted, site.slug, "visitor-a");
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("your daily answer limit");
		expect((await ask(restarted, site.slug, "visitor-b")).status).toBe(200);
	});
	const completer = () => {
		const calls: { system: string; prompt: string }[] = [];
		let reply: () => Promise<string> = async () => "model reply";
		return {
			calls,
			setReply: (next: () => Promise<string>) => {
				reply = next;
			},
			complete: async (input: { system: string; prompt: string }) => {
				calls.push(input);
				return reply();
			},
		};
	};
	const callAi = (
		h: ReturnType<typeof harness>,
		slug: string,
		payload: SiteDataValue,
		visitor?: string
	) =>
		h.visitor(
			slug,
			"/_ryu/complete",
			"POST",
			payload,
			visitor ? { authorization: `Bearer ${visitor}` } : {}
		);

	test("general AI composes owner instructions before page text without a Space", async () => {
		const model = completer();
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, {
			ai: true,
			aiMode: "general",
			aiSystemPrompt: "Always answer in French.",
		});
		expect(site.settings.spaceId).toBeNull();
		const config = await (await h.visitor(site.slug, "/_ryu/config")).json();
		expect(config).toMatchObject({ completions: true, aiAnonymous: false });
		const response = await callAi(
			h,
			site.slug,
			{ prompt: "Summarize this page", system: "Be brief." },
			"visitor-a"
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "model reply" });
		const system = model.calls[0]?.system ?? "";
		expect(model.calls[0]?.prompt).toBe("Summarize this page");
		expect(system.indexOf("Always answer in French.")).toBeGreaterThan(0);
		expect(system.indexOf("Always answer in French.")).toBeLessThan(
			system.indexOf("Be brief.")
		);
		const chat = await callAi(
			h,
			site.slug,
			{
				messages: [
					{ role: "user", content: "Hi" },
					{ role: "assistant", content: "Hello" },
					{ role: "user", content: "Classify: great product" },
				],
			},
			"visitor-a"
		);
		expect(chat.status).toBe(200);
		expect(model.calls[1]?.prompt).toContain("Classify: great product");
	});

	test("general AI is gated by mode, sign-in and the model service", async () => {
		const model = completer();
		const h = harness({
			identity,
			complete: model.complete,
			answer: async () => ({ text: "grounded", sources: [] }),
			retrieve: async () => [],
			canBindSpace: () => true,
		});
		const grounded = await connect(h, { ai: true, spaceId: "approved" });
		const refused = await callAi(
			h,
			grounded.slug,
			{ prompt: "Hi" },
			"visitor-a"
		);
		expect(refused.status).toBe(403);
		expect(await refused.text()).toContain("General AI is not enabled");

		const other = harness({ identity, complete: model.complete });
		const general = await connect(other, { ai: true, aiMode: "general" });
		const anonymous = await callAi(other, general.slug, { prompt: "Hi" });
		expect(anonymous.status).toBe(401);
		const updated = await other.admin(
			`/projects/${general.id}/settings`,
			"PUT",
			{
				settings: { ...general.settings, aiAnonymous: true },
				expectedRevision: general.revision,
			}
		);
		expect(updated.status).toBe(200);
		expect((await callAi(other, general.slug, { prompt: "Hi" })).status).toBe(
			200
		);
		expect(model.calls).toHaveLength(1);

		// No model service: the owner cannot enable general AI at all.
		const noModel = harness({ identity });
		await expect(
			connect(noModel, { ai: true, aiMode: "general" })
		).rejects.toThrow("Connect a Ryu model");
	});

	test("general AI never returns invented text when the model fails", async () => {
		const model = completer();
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, { ai: true, aiMode: "general" });
		model.setReply(() => Promise.reject(new SidecarHostError(503)));
		const failed = await callAi(h, site.slug, { prompt: "Hi" }, "visitor-a");
		expect(failed.status).toBe(503);
		expect(await failed.json()).not.toHaveProperty("text");
		model.setReply(async () => "   ");
		const empty = await callAi(h, site.slug, { prompt: "Hi" }, "visitor-a");
		expect(empty.status).toBe(503);
		expect(await empty.text()).toContain("no answer");
	});

	test("general AI maps every model failure except a permission denial to 503", async () => {
		const model = completer();
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, { ai: true, aiMode: "general" });
		const failures: (() => Promise<string>)[] = [
			() => Promise.reject(new TypeError("fetch failed")),
			() =>
				Promise.reject(
					new DOMException("The operation timed out.", "TimeoutError")
				),
			() => Promise.reject(new SidecarHostError(400)),
			() => Promise.reject(new SidecarHostError(500)),
			() =>
				Promise.resolve(
					z.string().parse({ text: "not a string" }) as unknown as string
				),
			() => Promise.resolve({ text: "object" } as unknown as string),
		];
		for (const failure of failures) {
			model.setReply(failure);
			const response = await callAi(
				h,
				site.slug,
				{ prompt: "Hi" },
				"visitor-a"
			);
			expect(response.status).toBe(503);
			const payload = await response.json();
			expect(payload).not.toHaveProperty("text");
			expect(payload.error.code).toBe("unavailable");
		}
		model.setReply(() => Promise.reject(new SidecarHostError(403)));
		const denied = await callAi(h, site.slug, { prompt: "Hi" }, "visitor-b");
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe(
			"platform_permission_required"
		);
	});

	test("general AI without a Space does not advertise grounded answers", async () => {
		const model = completer();
		const h = harness({
			identity,
			complete: model.complete,
			answer: async () => ({ text: "grounded", sources: [] }),
		});
		const site = await connect(h, { ai: true, aiMode: "general" });
		expect(site.settings.spaceId).toBeNull();
		const config = await (await h.visitor(site.slug, "/_ryu/config")).json();
		expect(config).toMatchObject({ answers: false, completions: true });
	});

	test("owner AI instructions are hidden from editors and viewers", async () => {
		const model = completer();
		const h = harness({
			complete: model.complete,
			managementIdentity: async () => ({
				id: "owner",
				email: "owner@example.com",
				workspaceIds: ["team"],
			}),
			identity: async (request) => {
				const principal = await identity(request);
				return principal?.id === "Bearer visitor-b"
					? { ...principal, workspaceIds: ["team"] }
					: principal;
			},
		});
		const site = await connect(h, {
			ai: true,
			aiMode: "general",
			aiSystemPrompt: "Confidential owner guidance.",
			audience: "invited",
			workspaceId: "team",
			viewers: ["a@example.com"],
			editors: ["b@example.com"],
		});
		const owner = await (await h.admin(`/projects/${site.id}`)).json();
		expect(owner.settings.aiSystemPrompt).toBe("Confidential owner guidance.");
		for (const [token, access] of [
			["visitor-a", "viewer"],
			["visitor-b", "editor"],
		] as const) {
			const detail = await h.admin(
				`/projects/${site.id}`,
				"GET",
				undefined,
				token
			);
			const text = await detail.text();
			expect(detail.status).toBe(200);
			expect(text).not.toContain("Confidential owner guidance.");
			expect(JSON.parse(text)).toMatchObject({
				access,
				settings: { aiSystemPrompt: "", aiMode: "general" },
			});
			const shared = await h.admin(
				"/projects?scope=shared",
				"GET",
				undefined,
				token
			);
			const list = await shared.text();
			expect(list).toContain(site.id);
			expect(list).not.toContain("Confidential owner guidance.");
		}
	});

	test("general AI caps prompts, clamps maxTokens and shares the daily answer limit", async () => {
		const model = completer();
		model.setReply(async () => "x".repeat(50_000));
		const h = harness({ identity, complete: model.complete });
		const site = await connect(h, {
			ai: true,
			aiMode: "general",
			aiDailyLimit: 10,
		});
		const tooLong = await callAi(
			h,
			site.slug,
			{ prompt: "a".repeat(8001) },
			"visitor-a"
		);
		expect(tooLong.status).toBe(413);
		expect(await tooLong.text()).toContain("8,000 characters");
		const both = await callAi(
			h,
			site.slug,
			{ prompt: "Hi", messages: [{ role: "user", content: "Hi" }] },
			"visitor-a"
		);
		expect(both.status).toBe(400);
		expect(model.calls).toHaveLength(0);

		const clamped = await callAi(
			h,
			site.slug,
			{ prompt: "Write a lot", maxTokens: 1_000_000 },
			"visitor-a"
		);
		expect(clamped.status).toBe(200);
		expect(model.calls[0]?.system).toContain("about 2000 tokens");
		const { text } = z.object({ text: z.string() }).parse(await clamped.json());
		expect(text).toHaveLength(8000);
		const small = await callAi(
			h,
			site.slug,
			{ prompt: "Short", maxTokens: 10 },
			"visitor-a"
		);
		expect(
			z.object({ text: z.string() }).parse(await small.json()).text
		).toHaveLength(40);
		// The visitor's share of 10 answers per day is 2.
		const over = await callAi(h, site.slug, { prompt: "Again" }, "visitor-a");
		expect(over.status).toBe(429);
		expect(await over.text()).toContain("your daily answer limit");
		expect(model.calls).toHaveLength(2);
		expect(
			(await callAi(h, site.slug, { prompt: "Hi" }, "visitor-b")).status
		).toBe(200);
	});
});
