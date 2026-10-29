import { fileURLToPath } from "node:url";
import {
	buildVisitorModule,
	canBuildVisitor,
	pinnedBunVersion,
	visitorBundlePath,
} from "./src/visitor-build.ts";

const check = process.argv.includes("--check");
const runtimeOnly = process.argv.includes("--runtime-only");

if (canBuildVisitor()) {
	const pinned = await pinnedBunVersion();
	if (pinned && Bun.version !== pinned) {
		const message = `The visitor runtime is reproducible only with bun@${pinned}; this is bun@${Bun.version}.`;
		if (check || runtimeOnly) {
			throw new Error(message);
		}
		// Rewriting the tracked runtime with another bundler release would dirty
		// it with output CI cannot reproduce, so keep the checked-in artifact.
		console.warn(`${message} Keeping the checked-in visitor runtime.`);
	} else {
		const generated = await buildVisitorModule();
		const current = await Bun.file(visitorBundlePath).text();
		if (check) {
			if (generated !== current) {
				throw new Error(
					"src/visitor-bundle.ts is stale. Run `bun run build.ts --runtime-only` and commit the result."
				);
			}
		} else if (generated !== current) {
			await Bun.write(visitorBundlePath, generated);
		}
	}
} else if (runtimeOnly || check) {
	throw new Error(
		"Install the Sites UI workspace dependencies to rebuild its browser runtime"
	);
}
/* Satellite builds use the checked-in browser artifact. */
if (!(runtimeOnly || check)) {
	const result = await Bun.build({
		compile: {
			outfile: fileURLToPath(new URL("./dist/ryu-sites", import.meta.url)),
		},
		entrypoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
	});
	if (!result.success) {
		throw new AggregateError(result.logs, "Sites sidecar build failed");
	}
}
