/**
 * The Sites sidecar process. Startup runs inside Effect: configuration errors
 * fail the program (non-zero exit), and the store, the two listeners and the
 * management endpoint file are scoped resources that SIGINT/SIGTERM release
 * in reverse order (endpoint file, listeners, routers, store).
 */
import { join } from "node:path";
import { resolvePluginDataDir, resolveSidecarPort } from "@ryu/sidecar-runtime";
import { brandingRemovable } from "@ryu/sidecar-runtime/branding";
import {
	runServiceMain,
	scopedResource,
} from "@ryu/sidecar-runtime/effect-http";
import { capturePluginKeys } from "@ryu/sidecar-runtime/seal";
import { Context, Effect, Layer } from "effect";
import { SitesIdentity } from "./identity.ts";
import { randomInstanceValue } from "./instance-proof.ts";
import {
	removeManagementEndpoint,
	writeManagementEndpoint,
} from "./mcp-server.ts";
import { loadRuntimeConfig } from "./runtime-config.ts";
import { SitesListeners, sitesServerLayer } from "./server.ts";
import { createSidecarServices } from "./sidecar-services.ts";
import { resolveSitesProcessConfig } from "./standalone-config.ts";
import { SitesStore } from "./store.ts";
import { visitorScript } from "./visitor-bundle.ts";

const asError = (cause: unknown) =>
	cause instanceof Error ? cause : new Error(String(cause));

/** A startup step whose thrown error stops the process with its message. */
const startup = <A>(run: () => A | Promise<A>) =>
	Effect.tryPromise({ try: async () => await run(), catch: asError });

const program = Layer.effectDiscard(
	Effect.gen(function* () {
		// Capture (and remove from the environment) the content key before
		// anything else runs, so no child process or log can see it.
		const keys = capturePluginKeys("@ryu/sites", Bun.env);
		const processConfig = yield* startup(() =>
			resolveSitesProcessConfig(Bun.env)
		);
		for (const warning of processConfig.warnings) {
			console.warn(`[ryu-sites] ${warning}`);
		}
		if (processConfig.mode === "standalone") {
			// Standalone Sites keeps its own private data; files it creates stay
			// owner-only.
			process.umask(0o077);
		}
		const directory = resolvePluginDataDir(Bun.env, "@ryu/sites");
		const runtimePath = join(directory, "runtime.json");
		const runtime = yield* startup(() => loadRuntimeConfig(runtimePath));
		const issuer = Bun.env.RYU_SITES_ISSUER ?? runtime.identity?.issuer;
		const clientId = Bun.env.RYU_SITES_CLIENT_ID ?? runtime.identity?.clientId;
		if (Boolean(issuer) !== Boolean(clientId)) {
			return yield* Effect.fail(
				new Error("Sites identity requires both issuer and client ID")
			);
		}
		const ownerId = Bun.env.RYU_SITES_OWNER_ID ?? runtime.ownerId;
		const store = yield* scopedResource(
			() => new SitesStore(join(directory, "sites.sqlite"), { keys }),
			(opened) => opened.close()
		);
		const identity =
			issuer && clientId
				? yield* startup(() =>
						SitesIdentity.connect({
							issuer,
							clientId,
							clientSecret: Bun.env.RYU_SITES_CLIENT_SECRET,
							toolAudience: runtime.identity?.toolAudience,
						})
					)
				: null;
		const services = yield* startup(() =>
			createSidecarServices({
				directory,
				env: Bun.env,
				identity,
				issuer,
				ownerId,
				processConfig,
				runtime,
				runtimePath,
				store,
			})
		);
		// Proves to the `ryu-sites mcp` lane that a loopback port is this
		// process before it sends the Core bearer there.
		const instanceSecret = randomInstanceValue();
		const options = yield* startup(() => ({
			services,
			instanceSecret,
			ownerId,
			store,
			token: processConfig.token,
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
		}));
		const { admin, visitor } = Context.get(
			yield* Layer.build(sitesServerLayer(options)),
			SitesListeners
		);
		// The `ryu-sites mcp` lane reads this to reach the running management
		// API. It is removed first on shutdown, and on any other exit.
		const forgetEndpoint = () =>
			removeManagementEndpoint(directory, instanceSecret);
		yield* scopedResource(
			() => {
				writeManagementEndpoint(directory, admin.port ?? 0, instanceSecret);
				process.once("exit", forgetEndpoint);
			},
			() => {
				process.off("exit", forgetEndpoint);
				forgetEndpoint();
			}
		);
		console.info(
			`[ryu-sites] ${processConfig.mode} mode; management ${processConfig.hostname}:${admin.port}; visitor ${processConfig.visitorHostname}:${visitor.port}`
		);
	})
);

runServiceMain(program, { name: "ryu-sites" });
