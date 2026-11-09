/**
 * Assembles the Sites sidecar's services from its process configuration and
 * `runtime.json`: Core retrieval, connections and Spaces databases when a
 * Core port is set, the local database and scanner in standalone mode, edge
 * readiness, and platform identity.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSitesConnections } from "./connections.ts";
import { createEdgeReadiness } from "./edge-readiness.ts";
import type { SitesIdentity } from "./identity.ts";
import { createLocalSitesDatabase } from "./local-database.ts";
import { createSitesRetrieval } from "./platform.ts";
import {
	type loadRuntimeConfig,
	runtimeConfigSchema,
} from "./runtime-config.ts";
import { createStandaloneScanner } from "./secret-scan.ts";
import type { SitesServices } from "./server-types.ts";
import { createSitesSpacesDatabase } from "./spaces-database.ts";
import type { SitesProcessConfig } from "./standalone-config.ts";
import type { SitesStore } from "./store.ts";

const MAX_CONFIG_BYTES = 64_000;

export interface SidecarServicesInput {
	directory: string;
	env: Record<string, string | undefined>;
	identity: SitesIdentity | null;
	issuer: string | undefined;
	ownerId: string | undefined;
	processConfig: SitesProcessConfig;
	runtime: Awaited<ReturnType<typeof loadRuntimeConfig>>;
	runtimePath: string;
	store: SitesStore;
}

/** Reads a small JSON config file, refusing an oversized one. */
function readSmallJson(path: string, oversized: string): unknown {
	if (statSync(path).size > MAX_CONFIG_BYTES) {
		throw new Error(oversized);
	}
	const text = readFileSync(path, "utf8");
	if (text.length > MAX_CONFIG_BYTES) {
		throw new Error(oversized);
	}
	return JSON.parse(text);
}

export function createSidecarServices(
	input: SidecarServicesInput
): SitesServices {
	const { env, processConfig, runtime, runtimePath, store, identity } = input;
	const { token } = processConfig;
	const standalone = processConfig.mode === "standalone";
	const bindingsPath = env.RYU_SITES_BINDINGS_FILE;
	const bindings = () => {
		try {
			const path = bindingsPath ?? runtimePath;
			if (!existsSync(path)) {
				return {};
			}
			const value = readSmallJson(path, "oversized") as {
				spaceBindings?: unknown;
			};
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
					userJwt: env.RYU_SITES_OWNER_JWT,
					ownerId: input.ownerId,
				})
			: null;
	const spacesDatabase =
		corePort > 0
			? createSitesSpacesDatabase({
					corePort,
					token,
					userJwt: env.RYU_SITES_OWNER_JWT,
				})
			: standalone
				? createLocalSitesDatabase({
						db: store.db,
						workDir: join(input.directory, "sites"),
						seal: store.seal,
					})
				: null;
	// Connection policy is reread on each request so an operator edit to
	// runtime.json applies without a restart. An unreadable file fails closed.
	const connectionConfig = () => {
		if (!existsSync(runtimePath)) {
			return runtimeConfigSchema.parse({});
		}
		return runtimeConfigSchema.parse(
			readSmallJson(runtimePath, "Sites connection configuration is oversized")
		);
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
	// No edge ships with Sites. An operator's edge/TLS provider can confirm
	// custom domains through a readiness URL; without one, domains stay
	// pending TLS.
	const edgeReadinessUrl =
		env.RYU_SITES_EDGE_READINESS_URL ?? runtime.edge?.readinessUrl;
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
			authorizationServer: input.issuer,
		});
	}
	return services;
}
