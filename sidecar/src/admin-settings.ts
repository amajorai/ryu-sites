/**
 * `PUT /projects/:siteId/settings`: the owner's Site settings, checked against
 * the services this sidecar actually has before anything is saved.
 */

import type { SiteCall } from "./admin-site-routes.ts";
import { settingsInput } from "./contracts.ts";
import type { SitesContext } from "./server-context.ts";
import { body, fail, json } from "./server-http.ts";

export async function saveSettings(
	context: SitesContext,
	call: SiteCall
): Promise<Response> {
	const { services, options, databaseLabel, identityRequired } = context;
	const { site, user } = call;
	const input = settingsInput.parse(await body(call.request));
	const settings = input.settings;
	if (
		JSON.stringify(settings.extensions) !==
		JSON.stringify(site.settings.extensions)
	) {
		return fail(
			"extensions_managed_separately",
			"Manage tools from Extensions"
		);
	}
	if (
		JSON.stringify(settings.database) !== JSON.stringify(site.settings.database)
	) {
		return fail(
			"database_managed_separately",
			"Connect a database from the Database settings"
		);
	}
	if (settings.storage && !settings.database) {
		return fail(
			"database_required",
			`Connect ${databaseLabel} before enabling durable records`
		);
	}
	if (settings.sharedData.enabled) {
		if (!settings.database) {
			return fail(
				"database_required",
				`Connect ${databaseLabel} before enabling shared data`
			);
		}
		if (settings.mode !== "connected") {
			return fail(
				"invalid_input",
				"Shared data requires the Connected to Ryu data runtime"
			);
		}
		if (!services.identity) {
			return identityRequired("shared data");
		}
	}
	if (settings.agentActions && site.template !== "reset-calendar") {
		return fail(
			"invalid_input",
			"Owner reset actions require the Reset calendar starter"
		);
	}
	if (settings.agentActions && !services.runResetAction) {
		return fail("unavailable", "Ryu agent execution is not connected", 503);
	}
	if (settings.agentActions && !services.identity) {
		return identityRequired("owner reset actions");
	}
	if (settings.audience === "public" && !options.publicEnabled) {
		return fail(
			"policy_denied",
			"Public publishing is disabled by the operator",
			403
		);
	}
	if (
		(settings.audience === "invited" ||
			settings.audience === "workspace" ||
			settings.optionalSignIn ||
			settings.editors.length) &&
		!services.identity
	) {
		return identityRequired("sharing or sign-in");
	}
	if (
		settings.workspaceId &&
		!user.workspaceIds.includes(settings.workspaceId)
	) {
		return fail("forbidden", "Choose a workspace you belong to", 403);
	}
	if (
		settings.spaceId &&
		!(services.retrieve && services.canBindSpace?.(site.id, settings.spaceId))
	) {
		return fail("unavailable", "Space retrieval is not connected", 503);
	}
	if (
		settings.ai &&
		settings.aiMode === "general" &&
		!(services.complete && settings.mode === "connected")
	) {
		return fail(
			"unavailable",
			"Connect a Ryu model and the Connected to Ryu runtime before enabling general AI",
			503
		);
	}
	if (
		settings.ai &&
		settings.aiMode === "grounded" &&
		(!(services.answer && settings.spaceId) || settings.mode !== "connected")
	) {
		return fail(
			"unavailable",
			"Connect a knowledge Space and answer service before enabling AI answers",
			503
		);
	}
	settings.viewers = settings.viewers.map((email) => email.toLowerCase());
	settings.editors = settings.editors.map((email) => email.toLowerCase());
	return json(
		context.store.mutate(site.id, input.expectedRevision, (current) => {
			current.settings = settings;
		})
	);
}
