/**
 * The Sites management and visitor listeners.
 *
 * Both route through `effect/http` routers (`./admin-routes.ts`,
 * `./visitor-routes.ts`) served by Bun. `sitesServerLayer` owns the routers
 * and the two listeners as scoped resources, so closing its scope stops the
 * listeners (visitor first, then management) and then disposes the routers.
 * `createSitesServer` builds the same layer synchronously for callers that
 * want plain handles.
 */
import {
	BunListener,
	effectWebHandler,
	scopedResource,
	serveBun,
} from "@ryu/sidecar-runtime/effect-http";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { adminRoutes } from "./admin-routes.ts";
import { routable } from "./effect-routes.ts";
import { createSitesContext } from "./server-context.ts";
import {
	ADMIN_MAX_REQUEST_BODY_BYTES,
	VISITOR_MAX_REQUEST_BODY_BYTES,
} from "./server-http.ts";
import type { ServerOptions } from "./server-types.ts";
import { visitorRoutes } from "./visitor-routes.ts";

export {
	AGENT_AUDIT_ACTION,
	AGENT_AUDIT_RETAINED,
	CONNECTIONS_AUDIT_ACTION,
	CONNECTIONS_AUDIT_RETAINED,
	REMIX_AUDIT_ACTION,
	SITES_AGENT_CLIENT,
	SITES_AGENT_CLIENT_HEADER,
} from "./server-audit.ts";
export { ADMIN_MAX_REQUEST_BODY_BYTES } from "./server-http.ts";
export type { ServerOptions, SitesServices } from "./server-types.ts";
export {
	SITES_API_VERSION,
	SITES_SERVICE_NAME,
	SITES_SERVICE_VERSION,
} from "./service-info.ts";
export { composeCompletion } from "./visitor-ai.ts";

/** The running management and visitor listeners. */
export class SitesListeners extends Context.Service<
	SitesListeners,
	{
		readonly admin: Bun.Server<unknown>;
		readonly visitor: Bun.Server<unknown>;
	}
>()("@ryu/sites/SitesListeners") {}

/**
 * The router for `routes`, disposed when the layer's scope closes. Its
 * `fetch` routes each request by its raw path segments (`routable`).
 */
const router = (routes: readonly HttpRouter.Route<never>[]) =>
	Effect.map(
		scopedResource(
			() => effectWebHandler(HttpRouter.addAll(routes)),
			(handler) => handler.dispose()
		),
		(handler) => ({
			fetch: (request: Request) => handler.fetch(routable(request)),
		})
	);

/** Serves `fetch` with Bun inside the current scope; returns the listener. */
const listen = (
	fetch: (request: Request) => Promise<Response>,
	options: Parameters<typeof serveBun>[1]
) =>
	Effect.map(Layer.build(serveBun(fetch, options)), (context) =>
		Context.get(context, BunListener)
	);

/**
 * Starts both listeners in the current scope. Closing it stops the visitor
 * listener, then the management listener, then disposes both routers.
 */
const sitesListeners = (options: ServerOptions) =>
	Effect.gen(function* () {
		const bound = { visitor: 0 };
		const context = createSitesContext(options, () => bound.visitor);
		const adminHandler = yield* router(adminRoutes(context));
		const visitorHandler = yield* router(visitorRoutes(context));
		const admin = yield* listen(adminHandler.fetch, {
			hostname: options.hostname ?? "127.0.0.1",
			port: options.port ?? 8021,
			// Above the largest route limit (`body()`'s 2_100_000 default), so
			// an oversized body reaches Sites and gets its own `too_large` error
			// with a request id, not the listener's empty 413.
			maxRequestBodySize: ADMIN_MAX_REQUEST_BODY_BYTES,
		});
		const visitor = yield* listen(visitorHandler.fetch, {
			hostname: options.visitorHostname ?? "127.0.0.1",
			port: options.visitorPort ?? 8022,
			maxRequestBodySize: VISITOR_MAX_REQUEST_BODY_BYTES,
		});
		bound.visitor = visitor.port ?? 0;
		return { admin, visitor };
	});

/**
 * The Sites listeners as a scoped layer. Closing it stops the visitor
 * listener, then the management listener, then disposes both routers.
 */
export function sitesServerLayer(
	options: ServerOptions
): Layer.Layer<SitesListeners> {
	return Layer.effect(SitesListeners)(sitesListeners(options));
}

/**
 * Starts both listeners now. `stop()` closes them at once, as before, and
 * then releases the routers; `close()` resolves once everything is released.
 * A listener that cannot bind throws Bun's own error (`EADDRINUSE`), as
 * before, after releasing whatever had already started.
 */
export function createSitesServer(options: ServerOptions) {
	const scope = Scope.makeUnsafe();
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= Effect.runPromise(Scope.close(scope, Exit.void));
		return closing;
	};
	// Run in the caller's scope rather than as a layer, so a failed start
	// returns its own cause at once instead of awaiting the async release.
	const started = Effect.runSyncExit(
		sitesListeners(options).pipe(Scope.provide(scope))
	);
	if (Exit.isFailure(started)) {
		close().catch(() => undefined);
		throw Cause.squash(started.cause);
	}
	const { admin, visitor } = started.value;
	return {
		admin,
		visitor,
		close,
		stop() {
			admin.stop(true);
			visitor.stop(true);
			close().catch(() => undefined);
		},
	};
}
