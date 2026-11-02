/**
 * The two pages the Sites sidecar itself renders for a visitor: the
 * "This site is private" sign-in page and the connection consent page. They
 * are served with `default-src 'none'`, so no script or host localizer can
 * translate them; they are translated here, in the visitor's
 * `Accept-Language`, like the "Powered by Ryu" badge in `respondent.ts`.
 * `scripts/sync-respondent-catalogs.mjs` reads the `tl("…")` literals below
 * into `respondent-catalog.generated.json`.
 *
 * Each `tl()` is a whole sentence: read vs read-and-write access and Site
 * editor vs owner are separate sentences, never spliced English words.
 * Translations are HTML-escaped before the (already escaped) values fill
 * their `{placeholders}`.
 */
import type { RuntimeSite, SitePrincipal } from "./contracts.ts";
import { escapeHtml } from "./html.ts";
import type { SiteConnection } from "./owner-connections.ts";
import {
	fillPlaceholders,
	negotiateRespondentLocale,
	type RespondentLocale,
} from "./respondent-locale.ts";

/** A translated sentence, escaped, then filled with escaped HTML `values`. */
function sentence(
	translated: string,
	values: Readonly<Record<string, string>> = {}
): string {
	return fillPlaceholders(escapeHtml(translated), values);
}

function documentShell(t: RespondentLocale, title: string, body: string) {
	return `<!doctype html><html lang="${escapeHtml(t.locale)}" dir="${t.dir}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><main>${body}</main></html>`;
}

/** The page a visitor without access sees on a private Site. */
export function privateSitePage(
	acceptLanguage: string | null | undefined,
	signIn: boolean
): string {
	const t = negotiateRespondentLocale(acceptLanguage);
	const action = signIn
		? `<a href="/_ryu/signin">${sentence(t.tl("Sign in with Ryu"))}</a>`
		: `<p>${sentence(t.tl("Platform sign-in is not configured."))}</p>`;
	return documentShell(
		t,
		sentence(t.tl("Private site")),
		`<h1>${sentence(t.tl("This site is private"))}</h1><p>${sentence(t.tl("Sign in with an account that has access."))}</p>${action}`
	);
}

/** "Written by …" and the verified summary for an owner-added binding. */
function ownerBindingCopy(t: RespondentLocale, connection: SiteConnection) {
	if (connection.addedBy === "editor") {
		return {
			heading: t.tl("Written by a Site editor"),
			verified: connection.readOnly
				? t.tl(
						"A Site editor added this connection. It runs the tool {tool} through the agent {agent} with read access."
					)
				: t.tl(
						"A Site editor added this connection. It runs the tool {tool} through the agent {agent} with read and write access."
					),
		};
	}
	return {
		heading: t.tl("Written by the Site owner"),
		verified: connection.readOnly
			? t.tl(
					"The Site owner added this connection. It runs the tool {tool} through the agent {agent} with read access."
				)
			: t.tl(
					"The Site owner added this connection. It runs the tool {tool} through the agent {agent} with read and write access."
				),
	};
}

/**
 * The visitor's review page. For owner bindings, the label and description
 * are the author's own words, so they are set apart from the facts Sites
 * verified: the tool and agent that run, the enforced access, and whether an
 * owner or an editor added it.
 */
export function connectionConsentPage(input: {
	acceptLanguage: string | null | undefined;
	connection: SiteConnection;
	site: Pick<RuntimeSite, "name">;
	user: Pick<SitePrincipal, "email">;
	ticket: string;
}): string {
	const { connection, site, user } = input;
	const t = negotiateRespondentLocale(input.acceptLanguage);
	const described = connection.description
		? `<p>${escapeHtml(connection.description)}</p>`
		: "";
	let origin = `${described}<p>${sentence(t.tl("Your Ryu operator approved this connection."))}</p>`;
	if (connection.source === "owner") {
		const copy = ownerBindingCopy(t, connection);
		const verified = sentence(copy.verified, {
			agent: `<code>${escapeHtml(connection.agentId)}</code>`,
			tool: `<code>${escapeHtml(connection.toolId)}</code>`,
		});
		origin = `<section><h2>${sentence(copy.heading)}</h2><p><strong>${escapeHtml(connection.label)}</strong></p>${described}</section><section><h2>${sentence(t.tl("Verified by Ryu"))}</h2><p>${verified}</p></section>`;
	}
	const request = connection.readOnly
		? t.tl(
				"{site} requests read access using your connected account. It runs as you, never as the Site owner."
			)
		: t.tl(
				"{site} requests read and write access using your connected account. It runs as you, never as the Site owner."
			);
	const body = `<h1>${sentence(t.tl("Allow {label}?"), { label: escapeHtml(connection.label) })}</h1>${origin}<p>${sentence(request, { site: escapeHtml(site.name) })}</p><p>${sentence(t.tl("Signed in as {email}. Existing provider and workspace permissions still apply. You can revoke access at any time."), { email: escapeHtml(user.email) })}</p><form method="post"><input type="hidden" name="ticket" value="${escapeHtml(input.ticket)}"><button name="decision" value="allow">${sentence(t.tl("Allow connection"))}</button><button name="decision" value="cancel">${sentence(t.tl("Cancel"))}</button></form>`;
	return documentShell(t, sentence(t.tl("Connection permissions")), body);
}
