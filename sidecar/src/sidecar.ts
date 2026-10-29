import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePluginDataDir, resolveSidecarPort } from "@ryu/sidecar-runtime";
import { brandingRemovable } from "@ryu/sidecar-runtime/branding";
import { capturePluginKeys } from "@ryu/sidecar-runtime/seal";
import { z } from "zod";
import { createSitesConnections } from "./connections.ts";
import { createEdgeReadiness } from "./edge-readiness.ts";
import { SitesIdentity } from "./identity.ts";
import { randomInstanceValue } from "./instance-proof.ts";
import { createLocalSitesDatabase } from "./local-database.ts";
import {
	removeManagementEndpoint,
	writeManagementEndpoint,
} from "./mcp-server.ts";
import { createSitesRetrieval } from "./platform.ts";
import { loadRuntimeConfig, runtimeConfigSchema } from "./runtime-config.ts";
import { createStandaloneScanner } from "./secret-scan.ts";
import { createSitesServer, type SitesServices } from "./server.ts";
import { createSitesSpacesDatabase } from "./spaces-database.ts";
import { resolveSitesProcessConfig } from "./standalone-config.ts";
import { SitesStore } from "./store.ts";
import { visitorScript } from "./visitor-bundle.ts";

// Capture (and remove from the environment) the content key before anything
// else runs, so no child process or log can see it.
const keys = capturePluginKeys("@ryu/sites", Bun.env);
const processConfig = resolveSitesProcessConfig(Bun.env);
for (const warning of processConfig.warnings) {
	console.warn(`[ryu-sites] ${warning}`);
}
const { token } = processConfig;
const standalone = processConfig.mode === "standalone";
if (standalone) {
	// Standalone Sites keeps its own private data; files it creates stay owner-only.
	process.umask(0o077);
}
const directory = resolvePluginDataDir(Bun.env, "@ryu/sites");
const runtimePath = join(directory, "runtime.json");
const runtime = await loadRuntimeConfig(runtimePath);
const issuer = Bun.env.RYU_SITES_ISSUER ?? runtime.identity?.issuer;
const clientId = Bun.env.RYU_SITES_CLIENT_ID ?? runtime.identity?.clientId;
if (Boolean(issuer) !== Boolean(clientId)) {
	throw new Error("Sites identity requires both issuer and client ID");
}
const ownerId = Bun.env.RYU_SITES_OWNER_ID ?? runtime.ownerId;
const store = new SitesStore(join(directory, "sites.sqlite"), { keys });
const identity =
	issuer && clientId
		? await SitesIdentity.connect({
				issuer,
				clientId,
				clientSecret: Bun.env.RYU_SITES_CLIENT_SECRET,
				toolAudience: runtime.identity?.toolAudience,
			})
		: null;
const bindingsPath = Bun.env.RYU_SITES_BINDINGS_FILE;
const bindings = () => {
	try {
		const path = bindingsPath ?? runtimePath;
		if (!existsSync(path)) {
			return {};
		}
		if (statSync(path).size > 64_000) {
			throw new Error("oversized");
		}
		const text = readFileSync(path, "utf8");
		if (text.length > 64_000) {
			throw new Error("oversized");
		}
		const value = JSON.parse(text);
		return z
			.record(z.string(), z.array(z.string()).max(30))
			.parse(bindingsPath ? value : (value.spaceBindings ?? {}));
	} catch {
		throw new Error(
			"Sites knowledge bindings are unavailable; retrieval refused"
		);
	}
};
// Standalone mode never builds a Core host client, so its management bearer
// is never sent to whatever listens on a Core port.
const corePort = processConfig.corePort ?? 0;
const retrieval =
	corePort > 0
		? createSitesRetrieval({
				corePort,
				token,
				bindings,
				userJwt: Bun.env.RYU_SITES_OWNER_JWT,
				ownerId,
			})
		: null;
const spacesDatabase =
	corePort > 0
		? createSitesSpacesDatabase({
				corePort,
				token,
				userJwt: Bun.env.RYU_SITES_OWNER_JWT,
			})
		: standalone
			? createLocalSitesDatabase({
					db: store.db,
					workDir: join(directory, "sites"),
					seal: store.seal,
				})
			: null;
// Connection policy is reread on each request so an operator edit to
// runtime.json applies without a restart. An unreadable file fails closed.
const connectionConfig = () => {
	if (!existsSync(runtimePath)) {
		return runtimeConfigSchema.parse({});
	}
	if (statSync(runtimePath).size > 64_000) {
		throw new Error("Sites connection configuration is oversized");
	}
	const text = readFileSync(runtimePath, "utf8");
	if (text.length > 64_000) {
		throw new Error("Sites connection configuration is oversized");
	}
	return runtimeConfigSchema.parse(JSON.parse(text));
};
const services: SitesServices = {
	ownerConnectionPolicy: () => {
		const config = connectionConfig();
		return {
			agents: config.ownerConnectionAgents,
			enabled: config.ownerConnections,
			readOnlyTools: config.ownerConnectionReadOnlyTools,
			tools: config.ownerConnectionTools ?? null,
		};
	},
};
if (identity && runtime.identity?.toolAudience && corePort > 0) {
	Object.assign(
		services,
		createSitesConnections({
			corePort,
			token,
			userJwt: identity.userJwt,
			bindings: () => connectionConfig().connectionBindings,
		})
	);
}
Object.assign(services, retrieval);
if (standalone) {
	services.scanArtifact = createStandaloneScanner({
		gateway: processConfig.gateway,
	});
}
if (spacesDatabase) {
	services.spacesDatabase = spacesDatabase;
}
// No edge ships with Sites. An operator's edge/TLS provider can confirm custom
// domains through a readiness URL; without one, domains stay pending TLS.
const edgeReadinessUrl =
	Bun.env.RYU_SITES_EDGE_READINESS_URL ?? runtime.edge?.readinessUrl;
if (edgeReadinessUrl) {
	services.domainReady = createEdgeReadiness({
		readinessUrl: edgeReadinessUrl,
	});
}
if (identity) {
	Object.assign(services, {
		identity: identity.identity,
		signIn: identity.handle,
		mcpIdentity: identity.mcpIdentity,
		authorizationServer: issuer,
	});
}
// Proves to the `ryu-sites mcp` lane that a loopback port is this process
// before it sends the Core bearer there.
const instanceSecret = randomInstanceValue();
const server = createSitesServer({
	services,
	instanceSecret,
	ownerId,
	store,
	token,
	mode: processConfig.mode,
	hostname: processConfig.hostname,
	visitorHostname: processConfig.visitorHostname,
	dashboardUrl: processConfig.dashboardUrl,
	port: resolveSidecarPort(Bun.env, "RYU_SITES_PORT", 8021),
	visitorPort: Bun.env.RYU_SITES_VISITOR_PORT
		? resolveSidecarPort(Bun.env, "RYU_SITES_VISITOR_PORT", 8022)
		: (runtime.visitorPort ??
			resolveSidecarPort(Bun.env, "RYU_SITES_VISITOR_PORT", 8022)),
	baseDomain: Bun.env.RYU_SITES_DOMAIN ?? runtime.baseDomain,
	poweredByRyu: !brandingRemovable(Bun.env),
	publicEnabled:
		Bun.env.RYU_SITES_PUBLIC === undefined
			? runtime.publicEnabled
			: Bun.env.RYU_SITES_PUBLIC === "1",
	trustedProxies:
		Bun.env.RYU_SITES_TRUSTED_PROXIES === undefined
			? runtime.trustedProxies
			: Bun.env.RYU_SITES_TRUSTED_PROXIES.split(","),
	visitorScript,
});
// The `ryu-sites mcp` lane reads this to reach the running management API.
writeManagementEndpoint(directory, server.admin.port, instanceSecret);
console.info(
	`[ryu-sites] ${processConfig.mode} mode; management ${processConfig.hostname}:${server.admin.port}; visitor ${processConfig.visitorHostname}:${server.visitor.port}`
);
const forgetEndpoint = () =>
	removeManagementEndpoint(directory, instanceSecret);
function stop() {
	forgetEndpoint();
	server.stop();
	store.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", forgetEndpoint);
