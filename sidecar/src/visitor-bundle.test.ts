import { expect, test } from "bun:test";
import {
	buildVisitorModule,
	canBuildVisitor,
	pinnedBunVersion,
	visitorBundlePath,
} from "./visitor-build.ts";
import { visitorScript } from "./visitor-bundle.ts";

test("the checked-in visitor runtime is what its source builds", async () => {
	const committed = await Bun.file(visitorBundlePath).text();
	expect(visitorScript.length).toBeGreaterThan(0);
	// Satellite checkouts lack the shared browser primitives, and other Bun
	// releases bundle differently; CI runs the workspace's pinned Bun.
	if (!canBuildVisitor() || (await pinnedBunVersion()) !== Bun.version) {
		return;
	}
	expect(await buildVisitorModule()).toBe(committed);
}, 60_000);

test("the shipped visitor runtime carries the shared-records SDK", () => {
	// Route and SDK tests import TypeScript sources, so a stale bundle would
	// still pass them while generated pages lose `RyuSite.shared`.
	expect(visitorScript).toContain("shared:");
	expect(visitorScript).toContain("EventSource");
	expect(visitorScript).toContain("shared/");
	expect(visitorScript).toContain("expectedRevision");
});
