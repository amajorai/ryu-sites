/**
 * Owner-only management routes under `/projects/:siteId`: reset checks,
 * settings, the Site database, visitor data, URL and domain bindings,
 * analytics and deletion. They run after the full permission chain in
 * `./admin-site-routes.ts`.
 */
import { resolveTxt } from "node:dns/promises";
import { bearerOk, SidecarHostError } from "@ryu/sidecar-runtime";
import { z } from "zod";
import { saveSettings } from "./admin-settings.ts";
import { named, type SiteAction, type SiteCall } from "./admin-site-routes.ts";
import { resetProvider, siteSlug } from "./contracts.ts";
import type { SitesContext } from "./server-context.ts";
import { body, domainInput, fail, json, revisionInput } from "./server-http.ts";
import { sharedRecordCount } from "./shared-records.ts";
import {
	listVisitorData,
	purgeVisitorData,
	visitorKey,
	visitorOwner,
} from "./visitor-data-admin.ts";

const VISITOR_DATA_ACTION = /^visitors\/([^/]+)\/data$/;

async function reset(context: SitesContext, call: SiteCall) {
	const { request, site, user } = call;
	// Visitor cookies authenticate editable page content too. Only the
	// trusted Companion's Core hop can authorize this owner operation.
	if (
		!bearerOk(
			request.headers.get("authorization") ?? undefined,
			context.options.token
		) ||
		request.headers.has("origin")
	) {
		return fail("forbidden", "Run reset checks from Ryu Sites Settings", 403);
	}
	const input = revisionInput
		.extend({ provider: resetProvider })
		.strict()
		.parse(await body(request, 10_000));
	if (input.expectedRevision !== site.revision) {
		return fail(
			"conflict",
			"Reload the Site before running a reset check",
			409
		);
	}
	if (site.template !== "reset-calendar" || !site.settings.agentActions) {
		return fail("disabled", "Enable owner reset checks in Settings first", 403);
	}
	if (!context.services.runResetAction) {
		return fail("unavailable", "Ryu agent execution is not connected", 503);
	}
	return json(
		await context.services.runResetAction({
			ownerId: user.id,
			provider: input.provider,
			siteId: site.id,
		})
	);
}

async function connectDatabase(context: SitesContext, call: SiteCall) {
	const { services, store } = context;
	const { site } = call;
	const input = revisionInput.strict().parse(await body(call.request));
	if (!services.spacesDatabase) {
		return fail(
			"unavailable",
			"Ryu Spaces database access is unavailable",
			503
		);
	}
	const binding = await services.spacesDatabase.ensureForSite({
		id: site.id,
		name: site.name,
	});
	const legacyRecords = store.legacyRecords(site.id);
	await services.spacesDatabase.importRecords(binding, legacyRecords);
	const connected = store.mutate(site.id, input.expectedRevision, (current) => {
		if (
			current.settings.database &&
			(current.settings.database.databaseId !== binding.databaseId ||
				current.settings.database.spaceId !== binding.spaceId)
		) {
			fail("conflict", "This Site already uses another database", 409);
		}
		current.settings.database = binding;
	});
	store.clearLegacyRecords(site.id);
	return json(connected);
}

async function purgeVisitor(context: SitesContext, call: SiteCall) {
	const { site, user, action } = call;
	const owner = visitorOwner(VISITOR_DATA_ACTION.exec(action)?.[1] ?? "");
	const audit = await purgeVisitorData({
		actor: user.id,
		database: context.services.spacesDatabase,
		databaseLabel: context.databaseLabel,
		owner,
		site,
		store: context.store,
		sharedDeleted: (collection, id) =>
			context.sharedHub.publish(site.id, { type: "delete", collection, id }),
	});
	return json({
		visitor: visitorKey(owner),
		deleted: {
			files: audit.files,
			fileBytes: audit.fileBytes,
			records: audit.records,
		},
		audit,
	});
}

async function checkDomain(context: SitesContext, call: SiteCall) {
	const { services, store } = context;
	const { site } = call;
	const input = revisionInput
		.extend({ host: domainInput })
		.strict()
		.parse(await body(call.request));
	const domain = site.domains.find(
		(candidate) => candidate.host === input.host
	);
	if (!domain) {
		return fail("not_found", "Domain not found", 404);
	}
	const records = await (services.resolveDomainTxtRecords ?? resolveTxt)(
		`_ryu-sites.${input.host}`
	).catch(() => []);
	const dnsOk = records.some(
		(record) => record.join("") === domain.verification
	);
	const tlsOk =
		dnsOk && (await services.domainReady?.(site.id, input.host)) === true;
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

function analytics(context: SitesContext, { site, url }: SiteCall) {
	const { db } = context.store;
	const days = z.coerce
		.number()
		.int()
		.min(1)
		.max(90)
		.parse(url.searchParams.get("days") ?? 7);
	const since = new Date(Date.now() - (days - 1) * 86_400_000)
		.toISOString()
		.slice(0, 10);
	const summary = db
		.query<{ pageViews: number; uniqueVisitors: number }, [string, string]>(
			"SELECT COALESCE(SUM(views),0) AS pageViews, COUNT(DISTINCT visitor) AS uniqueVisitors FROM traffic WHERE site=? AND day>=?"
		)
		.get(site.id, since);
	const daily = db
		.query<
			{ day: string; pageViews: number; uniqueVisitors: number },
			[string, string]
		>(
			"SELECT day, SUM(views) AS pageViews, COUNT(DISTINCT visitor) AS uniqueVisitors FROM traffic WHERE site=? AND day>=? GROUP BY day ORDER BY day"
		)
		.all(site.id, since);
	const topPages = db
		.query<
			{ path: string; pageViews: number; uniqueVisitors: number },
			[string, string]
		>(
			"SELECT path, SUM(views) AS pageViews, COUNT(DISTINCT visitor) AS uniqueVisitors FROM page_traffic WHERE site=? AND day>=? GROUP BY path ORDER BY pageViews DESC, path LIMIT 20"
		)
		.all(site.id, since);
	return json({ summary, daily, topPages });
}

async function deleteSite(context: SitesContext, call: SiteCall) {
	const { services, store } = context;
	const { site } = call;
	const input = revisionInput
		.extend({ slug: z.string() })
		.strict()
		.parse(await body(call.request));
	if (input.slug !== site.slug) {
		return fail("confirmation", "Type the Site URL name to delete it");
	}
	if (site.settings.database && !services.spacesDatabase) {
		return fail(
			"unavailable",
			"Ryu Spaces database access is unavailable, so Site records could not be removed",
			503
		);
	}
	store.mutate(site.id, input.expectedRevision, () => {});
	if (site.settings.database && services.spacesDatabase) {
		try {
			await services.spacesDatabase.deleteDatabase(site.settings.database);
		} catch (error) {
			if (!(error instanceof SidecarHostError) || error.status !== 404) {
				throw error;
			}
		}
	}
	store.delete(site.id);
	context.sharedHub.forget(site.id);
	return json({ deleted: true });
}

/** Saves one revision-checked change to the Site record. */
const mutation =
	<Shape extends z.ZodRawShape>(
		shape: Shape,
		apply: (
			context: SitesContext,
			call: SiteCall,
			input: z.infer<z.ZodObject<Shape>> & { expectedRevision: number }
		) => (current: SiteCall["site"]) => void
	) =>
	async (context: SitesContext, call: SiteCall) => {
		const input = revisionInput
			.extend(shape)
			.strict()
			.parse(await body(call.request)) as z.infer<z.ZodObject<Shape>> & {
			expectedRevision: number;
		};
		const change = apply(context, call, input);
		return json(
			context.store.mutate(call.site.id, input.expectedRevision, change)
		);
	};

const owner = (
	method: SiteAction["method"],
	action: string,
	serve: SiteAction["serve"]
): SiteAction => ({
	method,
	route: `/${action}`,
	matches: named(action),
	level: "owner",
	serve,
});

/** Owner actions, after the full permission chain. */
export const OWNER_ACTIONS: readonly SiteAction[] = [
	owner("POST", "reset", reset),
	owner("PUT", "settings", saveSettings),
	owner("POST", "database/connect", connectDatabase),
	owner("GET", "database", async (context, { site }) => {
		const binding = site.settings.database;
		const database = context.services.spacesDatabase;
		if (!(binding && database)) {
			return json({ connected: false });
		}
		return json({
			connected: true,
			database: binding,
			records: await database.count(binding),
			sharedRecords: await sharedRecordCount(database, binding),
		});
	}),
	owner("POST", "database/query", async (context, call) => {
		const binding = call.site.settings.database;
		const database = context.services.spacesDatabase;
		if (!(binding && database)) {
			// Whole sentences per mode, so the catalog holds each one complete.
			return context.standalone
				? fail("unavailable", "Connect the Site database first", 503)
				: fail("unavailable", "Connect a Ryu Spaces database first", 503);
		}
		const input = z
			.object({ query: z.string().trim().min(1).max(8000) })
			.strict()
			.parse(await body(call.request, 12_000));
		return json(await database.query(binding, input.query));
	}),
	owner("GET", "visitors", async (context, { site }) =>
		json(
			await listVisitorData({
				database: context.services.spacesDatabase,
				databaseLabel: context.databaseLabel,
				site,
				store: context.store,
			})
		)
	),
	{
		method: "DELETE",
		route: "/visitors/:visitor/data",
		matches: (action) => VISITOR_DATA_ACTION.test(action),
		level: "owner",
		serve: purgeVisitor,
	},
	owner(
		"PUT",
		"name",
		mutation(
			{ name: z.string().trim().min(1).max(100) },
			(_c, _s, input) => (current) => {
				current.name = input.name;
			}
		)
	),
	owner(
		"PUT",
		"url",
		mutation({ slug: siteSlug }, (context, { site }, input) => {
			context.store.assertSlugAvailable(input.slug, site.id);
			return (current) => {
				if (current.slug !== input.slug) {
					current.aliases = [
						...new Set([...current.aliases, current.slug]),
					].filter((alias) => alias !== input.slug);
					current.slug = input.slug;
				}
			};
		})
	),
	owner(
		"POST",
		"unpublish",
		mutation({}, () => (current) => {
			current.deploymentId = null;
		})
	),
	owner(
		"POST",
		"domains",
		mutation({ host: domainInput }, (context, _call, input) => {
			if (
				context.store
					.list()
					.some((candidate) =>
						candidate.domains.some((domain) => domain.host === input.host)
					)
			) {
				fail("conflict", "Domain already bound", 409);
			}
			return (current) => {
				if (current.domains.length >= 5) {
					fail("quota", "Domain limit reached", 429);
				}
				current.domains.push({
					host: input.host,
					status: "pending_dns",
					verification: crypto.randomUUID(),
					checkedAt: null,
				});
			};
		})
	),
	owner("POST", "domains/check", checkDomain),
	owner(
		"DELETE",
		"domains",
		mutation({ host: domainInput }, (_context, _call, input) => (current) => {
			current.domains = current.domains.filter(
				(domain) => domain.host !== input.host
			);
		})
	),
	owner("GET", "analytics", async (context, call) => analytics(context, call)),
	{
		method: "DELETE",
		route: "",
		matches: named(""),
		level: "owner",
		serve: deleteSite,
	},
];
