import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { escapeHtml } from "./html.ts";
import type { SiteConnection } from "./owner-connections.ts";
import { respondentLocale } from "./respondent-locale.ts";
import { connectionConsentPage, privateSitePage } from "./visitor-pages.ts";

const arabic = respondentLocale("ar");
const translated = (source: string) => escapeHtml(arabic.tl(source));

const connection: SiteConnection = {
	addedBy: "editor",
	agentId: "ryu",
	description: "Posts <i>updates</i>",
	id: "owner.slack",
	label: "Slack & <b>news</b>",
	readOnly: true,
	revision: "r1",
	source: "owner",
	toolId: "slack.post_message",
};

function consent(
	acceptLanguage: string | null,
	overrides: Partial<SiteConnection> = {}
) {
	return connectionConsentPage({
		acceptLanguage,
		connection: { ...connection, ...overrides },
		site: { name: "Team <hub>" },
		ticket: "ticket-1",
		user: { email: "visitor@example.com" },
	});
}

// With no Accept-Language the pages fall back to the node owner's locale, so
// the English default must not depend on the machine running the tests.
const LOCALE_ENV = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
	savedEnv = Object.fromEntries(
		LOCALE_ENV.map((name) => [name, process.env[name]])
	);
	for (const name of LOCALE_ENV) {
		delete process.env[name];
	}
});
afterEach(() => {
	for (const name of LOCALE_ENV) {
		const value = savedEnv[name];
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

describe("private Site page", () => {
	test("renders in English, left to right, by default", () => {
		const page = privateSitePage(null, true);
		expect(page).toContain('<html lang="en" dir="ltr">');
		expect(page).toContain("<h1>This site is private</h1>");
		expect(page).toContain('<a href="/_ryu/signin">Sign in with Ryu</a>');
		expect(privateSitePage("en", false)).toContain(
			"<p>Platform sign-in is not configured.</p>"
		);
	});

	test("follows an Arabic Accept-Language with dir=rtl and catalog copy", () => {
		const page = privateSitePage("ar, en;q=0.5", true);
		expect(page).toContain('<html lang="ar" dir="rtl">');
		expect(page).toContain(`<h1>${translated("This site is private")}</h1>`);
		expect(page).toContain(`<title>${translated("Private site")}</title>`);
		expect(page).toContain(translated("Sign in with Ryu"));
	});
});

describe("connection consent page", () => {
	test("names who added the binding and the access in whole sentences", () => {
		const page = consent("en");
		expect(page).toContain('<html lang="en" dir="ltr">');
		expect(page).toContain(
			"<h1>Allow Slack &amp; &lt;b&gt;news&lt;/b&gt;?</h1>"
		);
		expect(page).toContain("<h2>Written by a Site editor</h2>");
		expect(page).toContain(
			"A Site editor added this connection. It runs the tool <code>slack.post_message</code> through the agent <code>ryu</code> with read access."
		);
		expect(page).toContain(
			"Team &lt;hub&gt; requests read access using your connected account."
		);
		expect(page).toContain("Signed in as visitor@example.com.");
		expect(page).toContain("<p>Posts &lt;i&gt;updates&lt;/i&gt;</p>");
		expect(page).not.toContain("<b>news</b>");

		const owner = consent("en", { addedBy: "owner", readOnly: false });
		expect(owner).toContain("<h2>Written by the Site owner</h2>");
		expect(owner).toContain(
			"The Site owner added this connection. It runs the tool <code>slack.post_message</code> through the agent <code>ryu</code> with read and write access."
		);
		expect(owner).toContain(
			"Team &lt;hub&gt; requests read and write access using your connected account."
		);
	});

	test("operator bindings show the operator approval instead", () => {
		const page = consent("en", { addedBy: undefined, source: "operator" });
		expect(page).toContain("Your Ryu operator approved this connection.");
		expect(page).not.toContain("Written by");
	});

	test("follows an Arabic Accept-Language with dir=rtl and catalog copy", () => {
		const page = consent("ar");
		expect(page).toContain('<html lang="ar" dir="rtl">');
		expect(page).toContain(
			`<title>${translated("Connection permissions")}</title>`
		);
		expect(page).toContain(
			`<h2>${translated("Written by a Site editor")}</h2>`
		);
		expect(page).toContain(translated("Allow connection"));
		expect(page).toContain(
			'<input type="hidden" name="ticket" value="ticket-1">'
		);
	});
});
