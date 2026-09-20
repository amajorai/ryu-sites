import { join } from "node:path";
import {
	resolveSidecarDataDir,
	resolveSidecarPort,
	resolveSidecarToken,
} from "@ryu/sidecar-runtime";
import { z } from "zod";
import { SitesIdentity } from "./identity.ts";
import { createSitesRetrieval } from "./platform.ts";
import { loadRuntimeConfig } from "./runtime-config.ts";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createSitesServer } from "./server.ts";
import { SitesStore } from "./store.ts";
import { visitorScript } from "./visitor-bundle.ts";

const token = resolveSidecarToken(Bun.env, "RYU_SITES_TOKEN");
if (!token) {
	throw new Error("Sites requires its Core-minted extension token");
}
const directory = resolveSidecarDataDir(
	Bun.env,
	join(process.cwd(), ".ryu-sites")
);
const runtimePath = join(directory, "sites", "runtime.json");
const runtime = await loadRuntimeConfig(runtimePath);
const issuer = Bun.env.RYU_SITES_ISSUER ?? runtime.identity?.issuer;
const clientId = Bun.env.RYU_SITES_CLIENT_ID ?? runtime.identity?.clientId;
if (Boolean(issuer) !== Boolean(clientId)) throw new Error("Sites identity requires both issuer and client ID");
const ownerId = Bun.env.RYU_SITES_OWNER_ID ?? runtime.ownerId;
const store = new SitesStore(join(directory, "sites", "sites.sqlite"));
const identity =
	issuer && clientId
		? await SitesIdentity.connect({
				issuer,
				clientId,
				clientSecret: Bun.env.RYU_SITES_CLIENT_SECRET,
			})
		: null;
const bindingsPath = Bun.env.RYU_SITES_BINDINGS_FILE;
const bindings = () => {
 try {
  const path = bindingsPath ?? runtimePath;
  if (!existsSync(path)) return {};
  if (statSync(path).size > 64000) throw new Error("oversized");
  const text = readFileSync(path, "utf8");
  if (text.length > 64000) throw new Error("oversized");
  const value = JSON.parse(text);
  return z.record(z.string(), z.array(z.string()).max(30)).parse(bindingsPath ? value : value.spaceBindings ?? {});
 } catch { throw new Error("Sites knowledge bindings are unavailable; retrieval refused"); }
};
const corePort = Number(Bun.env.RYU_CORE_PORT);
const retrieval =
	Number.isInteger(corePort) && corePort > 0
		? createSitesRetrieval({
				corePort,
				token,
				bindings,
				userJwt: Bun.env.RYU_SITES_OWNER_JWT,
				ownerId,
			})
		: null;
const server = createSitesServer({
	services: {
		...retrieval,
		...(identity
			? { identity: identity.identity, signIn: identity.handle }
			: {}),
	},
	ownerId,
	store,
	token,
	port: resolveSidecarPort(Bun.env, "RYU_SITES_PORT", 8021),
	visitorPort: Bun.env.RYU_SITES_VISITOR_PORT ? resolveSidecarPort(Bun.env, "RYU_SITES_VISITOR_PORT", 8022) : runtime.visitorPort ?? resolveSidecarPort(Bun.env, "RYU_SITES_VISITOR_PORT", 8022),
	baseDomain: Bun.env.RYU_SITES_DOMAIN ?? runtime.baseDomain,
	publicEnabled: Bun.env.RYU_SITES_PUBLIC === undefined ? runtime.publicEnabled : Bun.env.RYU_SITES_PUBLIC === "1",
	visitorScript,
});
// biome-ignore lint/suspicious/noConsole: sidecar lifecycle diagnostic, no credentials.
console.info(
	`[ryu-sites] management ${server.admin.port}; visitor ${server.visitor.port}`
);
function stop() {
	server.stop();
	store.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
