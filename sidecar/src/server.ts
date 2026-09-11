import { createHash, createHmac } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { bearerOk, SidecarHostError } from "@ryu/sidecar-runtime";
import { z } from "zod";
import {
	canEdit,
	canVisit,
	isOwner,
	type RuntimeSite,
	resourceName,
	SITE_LIMITS,
	type SitePrincipal,
	saveVersionInput,
	settingsInput,
	siteSlug,
} from "./contracts.ts";
import { SiteError, type SitesStore } from "./store.ts";

export interface SitesServices {
	answer?: (siteId: string, spaceId: string, query: string) => Promise<unknown>;
	canBindSpace?: (siteId: string, spaceId: string) => boolean;
	/** Checks actual TLS/edge binding, not just a successful DNS lookup. */
	domainReady?: (siteId: string, host: string) => Promise<boolean>;
	/** Platform-verified identity. Never read user identity from arbitrary headers. */
	identity?: (request: Request) => Promise<SitePrincipal | null>;
	managementIdentity?: (request: Request) => Promise<SitePrincipal | null>;
	retrieve?: (
		siteId: string,
		spaceId: string,
		query: string
	) => Promise<unknown>;
	scanArtifact?: (
		html: string
	) => Promise<{ allowed: boolean; reason: string | null }>;
	signIn?: (request: Request) => Promise<Response | null>;
}
export interface ServerOptions {
	baseDomain?: string;
	ownerId?: string;
	port?: number;
	publicEnabled?: boolean;
	services?: SitesServices;
	store: SitesStore;
	token: string | null;
	visitorPort?: number;
	visitorScript?: string;
}
const revisionInput = z.object({
	expectedRevision: z.number().int().nonnegative(),
});
const json = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
const fail = (code: string, message: string, status = 400): never => {
	throw new SiteError(code, message, status);
};
async function body(request: Request, limit = 2_100_000): Promise<unknown> {
	if (!request.headers.get("content-type")?.includes("application/json")) {
		fail("invalid_input", "JSON body required", 415);
	}
	const reader = request.body?.getReader();
	if (!reader) {
		return fail("invalid_input", "Body required");
	}
	let size = 0;
	const chunks: Uint8Array[] = [];
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		size += chunk.value.byteLength;
		if (size > limit) {
			await reader.cancel();
			fail("too_large", "Request exceeds the size limit", 413);
		}
		chunks.push(chunk.value);
	}
	try {
		return JSON.parse(
			await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).text()
		);
	} catch {
		return fail("invalid_input", "Invalid JSON");
	}
}
const normalizeHost = (host: string) =>
	host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
const domainInput = z
	.string()
	.max(253)
	.regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);

export function createSitesServer(options: ServerOptions) {
	const { store } = options;
	const services = options.services ?? {};
	const baseDomain = options.baseDomain ?? "localhost";
	const trafficSalt = crypto.randomUUID();
	const rates = new Map<string, { minute: number; count: number }>();
	const owner: SitePrincipal = {
		id: options.ownerId ?? "node-owner",
		email: "",
		workspaceIds: [],
	};
	const limited = (key: string) => {
		const minute = Math.floor(Date.now() / 60_000);
		if (rates.size > 10_000) {
			for (const [id, value] of rates) {
				if (value.minute !== minute) {
					rates.delete(id);
				}
			}
		}
		if (rates.size > 10_000 && !rates.has(key)) {
			fail("rate_limit", "Server busy; retry shortly", 429);
		}
		const current = rates.get(key);
		const next = {
			minute,
			count: current?.minute === minute ? current.count + 1 : 1,
		};
		rates.set(key, next);
		if (next.count > 120) {
			fail("rate_limit", "Too many requests; retry shortly", 429);
		}
	};
	const guarded = async (run: () => Promise<Response>): Promise<Response> => {
		try {
			return await run();
		} catch (error) {
            if (error instanceof SidecarHostError) {
                const denied = error.status === 401 || error.status === 403;
                return json({ error: { code: denied ? "platform_permission_required" : "platform_unavailable", message: error.message } }, denied ? 403 : 503);
            }
			if (error instanceof SiteError) {
				return json(
					{ error: { code: error.code, message: error.message } },
					error.status
				);
			}
			if (error instanceof z.ZodError) {
				return json(
					{
						error: {
							code: "invalid_input",
							message: "Check the submitted fields",
							fields: error.issues.map((issue) => issue.path.join(".")),
						},
					},
					400
				);
			}
			return json(
				{
					error: {
						code: "internal_error",
						message: "The operation could not be completed",
					},
				},
				500
			);
		}
	};
	const admin = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 8021,
		maxRequestBodySize: 2_100_000,
		fetch: (request) =>
			guarded(async () => {
				const url = new URL(request.url);
				if (url.pathname === "/health") {
					return json({ ok: true });
				}
				const user = bearerOk(
					request.headers.get("authorization") ?? undefined,
					options.token
				)
					? services.managementIdentity
						? await services.managementIdentity(request)
						: owner
					: ((await services.identity?.(request)) ?? null);
				if (!user) {
					return fail("unauthorized", "Sign in to manage Sites", 401);
				}
				const path = url.pathname.replace(/^\/api\/sites(?=\/|$)/, "");
				if (path === "/runtime" && request.method === "GET") {
					return json({ script: options.visitorScript ?? "" });
				}
				if (path === "/status" && request.method === "GET") {
					return json({
						limits: SITE_LIMITS,
						publicEnabled: options.publicEnabled === true,
						identityAvailable: Boolean(services.identity),
						retrievalAvailable: Boolean(services.retrieve),
						answersAvailable: Boolean(services.answer),
						scannerAvailable: Boolean(services.scanArtifact),
						visitorPort: visitor.port,
						baseDomain,
					});
				}
				if (path === "/projects") {
					if (request.method === "GET") {
						return json(store.list().filter((site) => canEdit(site, user)));
					}
					if (request.method === "POST") {
						return json(store.create(await body(request), user), 201);
					}
				}
				const match = /^\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
				if (!match) {
					return fail("not_found", "Route not found", 404);
				}
				const site = store.get(match[1]);
				if (!canEdit(site, user)) {
					return fail("forbidden", "You cannot edit this Site", 403);
				}
				const action = match[2] ?? "";
				if (!action && request.method === "GET") {
					return json(site);
				}
				if (action === "security" && request.method === "GET") {
					const versionId =
						url.searchParams.get("versionId") ?? site.versions.at(-1)?.id;
					if (!versionId) {
						return fail("not_found", "Save a version before checking it", 404);
					}
					return json(
						await inspectSiteSecurity(site, versionId, store, services)
					);
				}
				if (action.startsWith("versions/") && request.method === "GET") {
					return json({ html: store.artifact(site.id, action.slice(9)) });
				}
				if (action === "versions" && request.method === "POST") {
					const input = saveVersionInput.parse(await body(request));
					const bytes = new TextEncoder().encode(input.html).length;
					if (bytes > 2_000_000) {
						return fail("quota", "Artifact exceeds 2 MB", 413);
					}
					if (!/^\s*<!doctype html/i.test(input.html)) {
						return fail(
							"incompatible",
							"Import a self-contained HTML build beginning with <!doctype html>"
						);
					}
					const saved = store.mutate(
						site.id,
						input.expectedRevision,
						(current) => {
							if (
								current.versions.length >= SITE_LIMITS.versions ||
								current.versions.reduce(
									(sum, version) => sum + version.bytes,
									0
								) +
									bytes >
									SITE_LIMITS.totalArtifactBytes
							) {
								fail("quota", "Saved version storage limit reached", 429);
							}
							const id = crypto.randomUUID();
							store.db
								.query("INSERT INTO artifacts VALUES(?,?,?)")
								.run(site.id, id, input.html);
							current.versions.push({
								id,
								bytes,
								message: input.message,
								commit: input.commit,
								createdAt: new Date().toISOString(),
							});
						}
					);
					return json(saved, 201);
				}
				if (action === "deploy" && request.method === "POST") {
					const input = revisionInput
						.extend({ versionId: z.string() })
						.strict()
						.parse(await body(request));
					if (!(site.hasPublished || isOwner(site, user))) {
						return fail(
							"forbidden",
							"The owner must deploy the first version",
							403
						);
					}
					const report = await inspectSiteSecurity(
						site,
						input.versionId,
						store,
						services
					);
					if (report.status !== "passed") {
						return fail("security_blocked", report.summary, 422);
					}
					return json(
						store.mutate(site.id, input.expectedRevision, (current) => {
							current.deploymentId = input.versionId;
							current.hasPublished = true;
						})
					);
				}
				if (!isOwner(site, user)) {
					return fail(
						"forbidden",
						"Only the Site owner can manage these settings",
						403
					);
				}
				if (action === "settings" && request.method === "PUT") {
					const input = settingsInput.parse(await body(request));
					if (input.settings.audience === "public" && !options.publicEnabled) {
						return fail(
							"policy_denied",
							"Public publishing is disabled by the operator",
							403
						);
					}
					if (
						(input.settings.audience === "invited" ||
							input.settings.audience === "workspace" ||
							input.settings.optionalSignIn ||
							input.settings.editors.length) &&
						!services.identity
					) {
						return fail(
							"unavailable",
							"Connect platform identity before enabling sharing or sign-in",
							503
						);
					}
					if (
						input.settings.workspaceId &&
						!user.workspaceIds.includes(input.settings.workspaceId)
					) {
						return fail("forbidden", "Choose a workspace you belong to", 403);
					}
					if (
						input.settings.spaceId &&
						!(
							services.retrieve &&
							services.canBindSpace?.(site.id, input.settings.spaceId)
						)
					) {
						return fail("unavailable", "Space retrieval is not connected", 503);
					}
					if (
						input.settings.ai &&
						(!(services.answer && input.settings.spaceId) ||
							input.settings.mode !== "connected")
					) {
						return fail(
							"unavailable",
							"Connect a knowledge Space and answer service before enabling AI answers",
							503
						);
					}
					input.settings.viewers = input.settings.viewers.map((email) =>
						email.toLowerCase()
					);
					input.settings.editors = input.settings.editors.map((email) =>
						email.toLowerCase()
					);
					return json(
						store.mutate(site.id, input.expectedRevision, (current) => {
							current.settings = input.settings;
						})
					);
				}
				if (action === "url" && request.method === "PUT") {
					const input = revisionInput
						.extend({ slug: siteSlug })
						.strict()
						.parse(await body(request));
					store.assertSlugAvailable(input.slug, site.id);
					return json(
						store.mutate(site.id, input.expectedRevision, (current) => {
							if (current.slug !== input.slug) {
								current.aliases = [
									...new Set([...current.aliases, current.slug]),
								].filter((alias) => alias !== input.slug);
								current.slug = input.slug;
							}
						})
					);
				}
				if (action === "unpublish" && request.method === "POST") {
					const input = revisionInput.strict().parse(await body(request));
					return json(
						store.mutate(site.id, input.expectedRevision, (current) => {
							current.deploymentId = null;
						})
					);
				}
				if (action === "domains" && request.method === "POST") {
					const input = revisionInput
						.extend({ host: domainInput })
						.strict()
						.parse(await body(request));
					if (
						store
							.list()
							.some((candidate) =>
								candidate.domains.some((domain) => domain.host === input.host)
							)
					) {
						return fail("conflict", "Domain already bound", 409);
					}
					return json(
						store.mutate(site.id, input.expectedRevision, (current) => {
							if (current.domains.length >= 5) {
								fail("quota", "Domain limit reached", 429);
							}
							current.domains.push({
								host: input.host,
								status: "pending_dns",
								verification: crypto.randomUUID(),
								checkedAt: null,
							});
						})
					);
				}
				if (action === "domains/check" && request.method === "POST") {
					const input = revisionInput
						.extend({ host: domainInput })
						.strict()
						.parse(await body(request));
					const domain = site.domains.find(
						(candidate) => candidate.host === input.host
					);
					if (!domain) {
						return fail("not_found", "Domain not found", 404);
					}
					const records = await resolveTxt(`_ryu-sites.${input.host}`).catch(
						() => []
					);
					const dnsOk = records.some(
						(record) => record.join("") === domain.verification
					);
					const tlsOk =
						dnsOk &&
						(await services.domainReady?.(site.id, input.host)) === true;
					return json(
						store.mutate(site.id, input.expectedRevision, (current) => {
							const binding = current.domains.find(
								(candidate) => candidate.host === input.host
							);
							if (binding) {
								binding.status = tlsOk
									? "active"
									: dnsOk
										? "pending_tls"
										: "pending_dns";
								binding.checkedAt = new Date().toISOString();
							}
						})
					);
				}
				if (action === "domains" && request.method === "DELETE") {
					const input = revisionInput
						.extend({ host: domainInput })
						.strict()
						.parse(await body(request));
					return json(
						store.mutate(site.id, input.expectedRevision, (current) => {
							current.domains = current.domains.filter(
								(domain) => domain.host !== input.host
							);
						})
					);
				}
				if (action === "analytics" && request.method === "GET") {
					const days = z.coerce
						.number()
						.int()
						.min(1)
						.max(90)
						.parse(url.searchParams.get("days") ?? 7);
					const since = new Date(Date.now() - (days - 1) * 86_400_000)
						.toISOString()
						.slice(0, 10);
					return json(
						store.db
							.query(
								"SELECT day, SUM(views) AS pageViews, COUNT(*) AS uniqueVisitors FROM traffic WHERE site=? AND day>=? GROUP BY day ORDER BY day"
							)
							.all(site.id, since)
					);
				}
				if (!action && request.method === "DELETE") {
					const input = revisionInput
						.extend({ slug: z.string() })
						.strict()
						.parse(await body(request));
					if (input.slug !== site.slug) {
						return fail("confirmation", "Type the Site URL name to delete it");
					}
					store.mutate(site.id, input.expectedRevision, () => {});
					store.delete(site.id);
					return json({ deleted: true });
				}
				return fail("not_found", "Operation not found", 404);
			}),
	});
	const visitor = Bun.serve({
		hostname: "127.0.0.1",
		port: options.visitorPort ?? 8022,
		maxRequestBodySize: 7_000_000,
		fetch: (incoming, server) =>
            guarded(async () => {
                const url = new URL(incoming.url);
                // Public deployments terminate TLS at their managed edge. The scheme
                // comes from trusted deployment configuration, never a forwarded header.
                if (baseDomain !== "localhost") { url.protocol = "https:"; url.port = ""; }
                const request = url.href === incoming.url ? incoming : new Request(url, incoming);
				const host = normalizeHost(request.headers.get("host") ?? "");
				const site = store
					.list()
					.find(
						(candidate) =>
							host === `${candidate.slug}.${baseDomain}` ||
							candidate.aliases.some(
								(alias) => host === `${alias}.${baseDomain}`
							) ||
							candidate.domains.some(
								(domain) => domain.host === host && domain.status === "active"
							)
					);
				if (!site?.deploymentId) {
					return fail("not_found", "Site is not deployed", 404);
				}
				const ip = server.requestIP(incoming)?.address ?? "unknown";
				limited(`${site.id}:${ip}`);
				const authResponse = await services.signIn?.(request);
				if (authResponse) {
					return authResponse;
				}
				const user = (await services.identity?.(request)) ?? null;
				if (!canVisit(site, user)) {
					if (request.method === "GET" && !url.pathname.startsWith("/_ryu/")) {
						return new Response(
							`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Private site</title><main><h1>This site is private</h1><p>Sign in with an account that has access.</p>${services.signIn ? '<a href="/_ryu/signin">Sign in with Ryu</a>' : "<p>Platform sign-in is not configured.</p>"}</main></html>`,
							{
								status: 403,
								headers: {
									"content-type": "text/html",
									"cache-control": "no-store",
									"content-security-policy":
										"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
								},
							}
						);
					}
					return fail(
						"forbidden",
						"Sign in with an account that has access to this Site",
						403
					);
				}
				if (site.aliases.some((alias) => host === `${alias}.${baseDomain}`)) {
					url.hostname = `${site.slug}.${baseDomain}`;
					return Response.redirect(url.toString(), 308);
				}
				if (
					!["GET", "HEAD"].includes(request.method) &&
					request.headers.get("origin") !== url.origin
				) {
					return fail(
						"origin_denied",
						"Request origin does not match the Site",
						403
					);
				}
				if (url.pathname === "/_ryu/runtime.js" && request.method === "GET") {
					return new Response(options.visitorScript ?? "", {
						headers: {
							"content-type": "text/javascript",
							"x-content-type-options": "nosniff",
						},
					});
				}
				if (url.pathname === "/_ryu/config" && request.method === "GET") {
					return json({
						mode: site.settings.mode,
						knowledge: Boolean(site.settings.spaceId && services.retrieve),
						answers: site.settings.ai && Boolean(services.answer),
						records: site.settings.storage,
						uploads: site.settings.uploads,
						signIn: Boolean(services.identity),
					});
				}
				if (url.pathname === "/_ryu/identity" && request.method === "GET") {
					return json(user ? { id: user.id, email: user.email } : null);
				}
				if (url.pathname.startsWith("/_ryu/")) {
					return visitorData(request, url, site, user, store, services);
				}
				if (request.method !== "GET" && request.method !== "HEAD") {
					return fail("method", "Method not allowed", 405);
				}
				const day = new Date().toISOString().slice(0, 10);
				const visitorId = createHmac("sha256", trafficSalt)
					.update(
						`${day}:${site.id}:${ip}:${request.headers.get("user-agent") ?? ""}`
					)
					.digest("hex")
					.slice(0, 24);
				if (request.method === "GET") {
					store.db
						.query(
							"INSERT INTO traffic VALUES(?,?,?,1) ON CONFLICT(site,day,visitor) DO UPDATE SET views=views+1"
						)
						.run(site.id, day, visitorId);
					store.db
						.query("DELETE FROM traffic WHERE day<?")
						.run(
							new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
						);
				}
				const html = store.artifact(site.id, site.deploymentId);
				return new Response(request.method === "HEAD" ? null : html, {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
						"referrer-policy": "no-referrer",
						"permissions-policy":
							"camera=(), microphone=(), geolocation=(), payment=()",
						"content-security-policy":
							"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
						"cross-origin-opener-policy": "same-origin",
						"cross-origin-resource-policy": "same-origin",
                        ...(baseDomain !== "localhost" ? { "strict-transport-security": "max-age=31536000" } : {}),
					},
				});
			}),
	});
	return {
		admin,
		visitor,
		stop() {
			admin.stop(true);
			visitor.stop(true);
		},
	};
}

async function visitorData(
	request: Request,
	url: URL,
	site: RuntimeSite,
	user: SitePrincipal | null,
	store: SitesStore,
	services: SitesServices
): Promise<Response> {
	if (site.settings.mode !== "connected") {
		return fail("disabled", "This Site uses browser-local data", 403);
	}
	if (url.pathname === "/_ryu/ask" && request.method === "POST") {
		if (!(site.settings.ai && site.settings.spaceId && services.answer)) {
			return fail("unavailable", "Answers are unavailable for this Site", 503);
		}
		const input = z
			.object({ query: z.string().trim().min(1).max(2000) })
			.strict()
			.parse(await body(request, 10_000));
		const day = new Date().toISOString().slice(0, 10);
		store.db.transaction(() => {
			const usage = store.db
				.query(
					"SELECT count FROM operation_usage WHERE site=? AND day=? AND kind='answer'"
				)
				.get(site.id, day) as { count: number } | null;
			if ((usage?.count ?? 0) >= site.settings.aiDailyLimit) {
				fail("quota", "This Site has reached its daily answer limit", 429);
			}
			store.db
				.query(
					"INSERT INTO operation_usage VALUES(?,?,'answer',1) ON CONFLICT(site,day,kind) DO UPDATE SET count=count+1"
				)
				.run(site.id, day);
		})();
		return json(
			await services.answer(site.id, site.settings.spaceId, input.query)
		);
	}
	if (url.pathname === "/_ryu/search" && request.method === "POST") {
		if (!(site.settings.spaceId && services.retrieve)) {
			return fail("unavailable", "No knowledge source is bound", 503);
		}
		const input = z
			.object({ query: z.string().trim().min(1).max(2000) })
			.strict()
			.parse(await body(request, 10_000));
		return json(
			await services.retrieve(site.id, site.settings.spaceId, input.query)
		);
	}
	if (!user) {
		return fail("unauthorized", "Sign in to use saved records and files", 401);
	}
	const record = /^\/_ryu\/records\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
	if (record) {
		if (!site.settings.storage) {
			return fail("disabled", "Record storage is disabled", 403);
		}
		const collection = resourceName.parse(record[1]);
		const key = record[2] ? resourceName.parse(record[2]) : null;
		if (request.method === "GET") {
			return json(
				(
					store.db
						.query(
							"SELECT key,value FROM records WHERE site=? AND owner=? AND collection=? AND (? IS NULL OR key=?) LIMIT 1000"
						)
						.all(site.id, user.id, collection, key, key) as {
						key: string;
						value: string;
					}[]
				).map((row) => ({ key: row.key, value: JSON.parse(row.value) }))
			);
		}
		if (!key) {
			return fail("invalid_input", "A record key is required");
		}
		if (request.method === "DELETE") {
			store.db
				.query(
					"DELETE FROM records WHERE site=? AND owner=? AND collection=? AND key=?"
				)
				.run(site.id, user.id, collection, key);
			return json({ deleted: true });
		}
		if (request.method === "PUT") {
			const value = JSON.stringify(
				await body(request, SITE_LIMITS.recordBytes)
			);
			const count = store.db
				.query("SELECT COUNT(*) AS count FROM records WHERE site=?")
				.get(site.id) as { count: number };
			const existing = store.db
				.query(
					"SELECT key FROM records WHERE site=? AND owner=? AND collection=? AND key=?"
				)
				.get(site.id, user.id, collection, key);
			if (!existing && count.count >= SITE_LIMITS.records) {
				return fail("quota", "Record limit reached", 429);
			}
			store.db
				.query(
					"INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(site,owner,collection,key) DO UPDATE SET value=excluded.value"
				)
				.run(site.id, user.id, collection, key, value);
			return json({ saved: true });
		}
	}
	if (url.pathname === "/_ryu/files" && request.method === "POST") {
		if (!site.settings.uploads) {
			return fail("disabled", "Uploads are disabled", 403);
		}
		const input = z
			.object({
				name: z.string().min(1).max(200),
				data: z.string().max(6_700_000),
			})
			.strict()
			.parse(await body(request, 6_800_000));
		const data = Buffer.from(input.data, "base64");
		if (data.length > SITE_LIMITS.fileBytes) {
			return fail("quota", "File exceeds 5 MB", 413);
		}
		const count = store.db
			.query("SELECT COUNT(*) AS count FROM files WHERE site=?")
			.get(site.id) as { count: number };
		if (count.count >= SITE_LIMITS.files) {
			return fail("quota", "File limit reached", 429);
		}
		const id = crypto.randomUUID();
		store.db
			.query("INSERT INTO files VALUES(?,?,?,?,?,?)")
			.run(site.id, user.id, id, input.name, "application/octet-stream", data);
		return json({ id, name: input.name, bytes: data.length }, 201);
	}
	const file = /^\/_ryu\/files\/([a-f0-9-]+)$/.exec(url.pathname);
	if (file && site.settings.uploads) {
		const row = store.db
			.query("SELECT data FROM files WHERE site=? AND owner=? AND id=?")
			.get(site.id, user.id, file[1]) as { data: Uint8Array } | null;
		if (!row) {
			return fail("not_found", "File not found", 404);
		}
		if (request.method === "GET") {
			return new Response(new Uint8Array(row.data), {
				headers: {
					"content-type": "application/octet-stream",
					"content-disposition": "attachment",
					"x-content-type-options": "nosniff",
					"cache-control": "no-store",
				},
			});
		}
		if (request.method === "DELETE") {
			store.db
				.query("DELETE FROM files WHERE site=? AND owner=? AND id=?")
				.run(site.id, user.id, file[1]);
			return json({ deleted: true });
		}
	}
	return fail("not_found", "Resource not found", 404);
}

async function inspectSiteSecurity(
	site: RuntimeSite,
	versionId: string,
	store: SitesStore,
	services: SitesServices
) {
	const html = store.artifact(site.id, versionId);
	const artifactDigest = createHash("sha256").update(html).digest("hex");
	let status: "passed" | "blocked" | "unavailable" = "unavailable";
	let summary =
		"The Gateway secret scanner is unavailable. Deployment is blocked.";
	if (services.scanArtifact) {
		try {
			const result = await services.scanArtifact(html);
			status = result.allowed ? "passed" : "blocked";
			summary = result.allowed
				? "No known secret patterns detected in this saved version."
				: "A potential secret was detected. Remove it from the site before deploying.";
		} catch {
			/* An unavailable scanner never becomes a passed check. */
		}
	}
	return {
		versionId,
		artifactDigest,
		checkedAt: new Date().toISOString(),
		status,
		summary,
		protections: [
			{
				name: "Separate visitor origin",
				detail:
					"Generated pages cannot access the Companion or its credentials.",
			},
			{
				name: "Restricted browser capabilities",
				detail:
					"External connections, embedding, camera, microphone and location are blocked by default.",
			},
			{
				name: "Server-side data permissions",
				detail:
					"Durable records and files require verified identity and remain scoped to the site and visitor.",
			},
			{
				name: "Bounded requests and uploads",
				detail: "The service enforces request, storage and file-size limits.",
			},
		],
		limitation:
			"This checks known secret patterns and runtime posture. It is not a complete code audit, penetration test or compliance certification.",
	};
}
