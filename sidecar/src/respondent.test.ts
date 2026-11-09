import { afterAll, describe, expect, test } from "bun:test";
import { poweredByRyuCopy } from "./respondent.ts";
import {
	create,
	deploy,
	harness,
	publish,
	runCleanup,
	save,
} from "./server-harness.ts";

afterAll(runCleanup);

describe("Powered by Ryu badge copy", () => {
	test("follows the visitor's Accept-Language and direction", () => {
		const arabic = poweredByRyuCopy("ar, en;q=0.5");
		expect(arabic.dir).toBe("rtl");
		expect(arabic.ariaLabel).not.toBe("Powered by Ryu — make your own");
		const english = poweredByRyuCopy("en-GB");
		expect(english).toEqual({
			ariaLabel: "Powered by Ryu — make your own",
			dir: "ltr",
			label: "Powered by <b>Ryu</b>",
		});
	});

	test("a published page carries the badge in the visitor's language", async () => {
		const branded = harness({}, true, [], ":memory:", true);
		const site = await publish(
			branded,
			await deploy(branded, await save(branded, await create(branded)))
		);
		const response = await branded.visitor(site.slug, "/", "GET", undefined, {
			"accept-language": "fr-FR,fr;q=0.9",
		});
		expect(response.headers.get("vary")).toContain("Accept-Language");
		const page = await response.text();
		expect(page).toContain('aria-label="Propulsé par Ryu — créez le vôtre"');
	});
});
