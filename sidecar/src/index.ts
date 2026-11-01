/**
 * `ryu-sites` runs the Sites sidecar. `ryu-sites mcp` instead serves the
 * `sites` agent tools over stdio against the running sidecar.
 */
import { runSitesMcp } from "./mcp-server.ts";

if (Bun.argv[2] === "mcp") {
	await runSitesMcp(Bun.env);
} else {
	await import("./sidecar.ts");
}
