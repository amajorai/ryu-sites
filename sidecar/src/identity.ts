import { createHash } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import type { SitePrincipal } from "./contracts.ts";
import { SiteError } from "./store.ts";

const discoverySchema = z.object({
	issuer: z.string().url(),
	authorization_endpoint: z.string().url(),
	token_endpoint: z.string().url(),
	jwks_uri: z.string().url(),
});
interface PendingLogin {
	expires: number;
	nonce: string;
	origin: string;
	verifier: string;
}
interface VisitorSession {
	expires: number;
	origin: string;
	user: SitePrincipal;
}
/** OIDC client for the existing platform identity provider; no local account database. */
export class SitesIdentity {
	private readonly pending = new Map<string, PendingLogin>();
	private readonly sessions = new Map<string, VisitorSession>();
	private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
	private constructor(
		private readonly config: {
			issuer: string;
			clientId: string;
			clientSecret?: string;
			fetchImpl?: typeof fetch;
		},
		private readonly discovery: z.infer<typeof discoverySchema>
	) {
		this.jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), {
			[customFetch]: config.fetchImpl ?? fetch,
		});
	}
	static async connect(config: {
		issuer: string;
		clientId: string;
		clientSecret?: string;
		fetchImpl?: typeof fetch;
	}) {
		const issuer = new URL(config.issuer);
		if (issuer.protocol !== "https:") {
			throw new Error("Sites identity requires an HTTPS issuer");
		}
		const response = await (config.fetchImpl ?? fetch)(
			`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
			{ redirect: "error", signal: AbortSignal.timeout(10_000) }
		);
		if (!response.ok) {
			throw new Error("Identity discovery failed");
		}
		const discovery = discoverySchema.parse(await response.json());
		if (discovery.issuer !== config.issuer) {
			throw new Error("Identity issuer mismatch");
		}
		for (const endpoint of [
			discovery.authorization_endpoint,
			discovery.token_endpoint,
			discovery.jwks_uri,
		]) {
			if (new URL(endpoint).protocol !== "https:") {
				throw new Error("Identity endpoints require HTTPS");
			}
		}
		return new SitesIdentity(config, discovery);
	}
	private cookieName(origin: string) {
		return origin.startsWith("https:")
			? "__Host-ryu-site-session"
			: "ryu-site-session";
	}
	private cookie(request: Request): string | undefined {
		const name = this.cookieName(new URL(request.url).origin);
		return request.headers
			.get("cookie")
			?.split(";")
			.map((value) => value.trim())
			.find((value) => value.startsWith(`${name}=`))
			?.slice(name.length + 1);
	}
	identity = async (request: Request): Promise<SitePrincipal | null> => {
		const id = this.cookie(request);
		const session = id ? this.sessions.get(id) : null;
		if (
			!session ||
			session.expires <= Date.now() ||
			session.origin !== new URL(request.url).origin
		) {
			return null;
		}
		return session.user;
	};
	handle = async (request: Request): Promise<Response | null> => {
		const url = new URL(request.url);
		for (const [id, value] of this.pending) {
			if (value.expires <= Date.now()) {
				this.pending.delete(id);
			}
		}
		for (const [id, value] of this.sessions) {
			if (value.expires <= Date.now()) {
				this.sessions.delete(id);
			}
		}
		const cookie = (value: string, seconds: number) =>
			`${this.cookieName(url.origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${url.protocol === "https:" ? "; Secure" : ""}`;
		if (url.pathname === "/_ryu/signout" && request.method === "POST") {
			if (request.headers.get("origin") !== url.origin) {
				throw new SiteError("origin_denied", "Invalid sign-out origin", 403);
			}
			const id = this.cookie(request);
			if (id) {
				this.sessions.delete(id);
			}
			return Response.json(
				{ signedOut: true },
				{
					status: 200,
					headers: {
						"set-cookie": cookie("", 0),
						"cache-control": "no-store",
					},
				}
			);
		}
		if (url.pathname === "/_ryu/signin" && request.method === "GET") {
			if (this.pending.size >= 1000) {
				throw new SiteError("rate_limit", "Too many pending sign-ins", 429);
			}
			const state = crypto.randomUUID();
			const verifier =
				`${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
			const nonce = crypto.randomUUID();
			this.pending.set(state, {
				verifier,
				nonce,
				origin: url.origin,
				expires: Date.now() + 600_000,
			});
			const destination = new URL(this.discovery.authorization_endpoint);
			destination.search = new URLSearchParams({
				client_id: this.config.clientId,
				response_type: "code",
				scope: "openid email profile",
				redirect_uri: `${url.origin}/_ryu/callback`,
				state,
				nonce,
				code_challenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				code_challenge_method: "S256",
			}).toString();
			return new Response(null, {
				status: 302,
				headers: {
					location: destination.toString(),
					"set-cookie": `ryu-site-login=${state}; Path=/_ryu; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol === "https:" ? "; Secure" : ""}`,
					"cache-control": "no-store",
				},
			});
		}
		if (url.pathname !== "/_ryu/callback" || request.method !== "GET") {
			return null;
		}
		const state = url.searchParams.get("state") ?? "";
		const pending = this.pending.get(state);
		this.pending.delete(state);
		const browserState = request.headers
			.get("cookie")
			?.split(";")
			.map((value) => value.trim())
			.find((value) => value.startsWith("ryu-site-login="))
			?.slice(15);
		if (!pending || pending.origin !== url.origin || browserState !== state) {
			throw new SiteError(
				"unauthorized",
				"Sign-in expired or did not match this browser",
				401
			);
		}
		const code = url.searchParams.get("code");
		if (!code) {
			throw new SiteError("unauthorized", "Sign-in was not completed", 401);
		}
		const parameters = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: this.config.clientId,
			code,
			redirect_uri: `${url.origin}/_ryu/callback`,
			code_verifier: pending.verifier,
		});
		if (this.config.clientSecret) {
			parameters.set("client_secret", this.config.clientSecret);
		}
		const response = await (this.config.fetchImpl ?? fetch)(
			this.discovery.token_endpoint,
			{
				method: "POST",
				body: parameters,
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			}
		);
		if (!response.ok) {
			throw new SiteError(
				"unauthorized",
				"Identity token exchange failed",
				401
			);
		}
		const tokens = z
			.object({ id_token: z.string() })
			.parse(await response.json());
		const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
			issuer: this.config.issuer,
			audience: this.config.clientId,
			requiredClaims: ["sub", "exp", "iat", "nonce"],
			maxTokenAge: "10m",
		});
		if (payload.nonce !== pending.nonce || payload.email_verified !== true) {
			throw new SiteError(
				"unauthorized",
				"A verified email identity is required",
				401
			);
		}
		const email = z.string().email().parse(payload.email).toLowerCase();
		if (this.sessions.size >= 10_000) {
			throw new SiteError("rate_limit", "Session limit reached", 429);
		}
		const id = crypto.randomUUID();
		const seconds = Math.min(
			3600,
			Math.max(0, (payload.exp ?? 0) - Math.floor(Date.now() / 1000))
		);
		// Only the configured issuer's signed workspace claims are accepted.
		const workspaceIds = z
			.array(z.string())
			.catch([])
			.parse(payload.workspaceIds);
		this.sessions.set(id, {
			user: { id: payload.sub ?? "", email, workspaceIds },
			origin: url.origin,
			expires: Date.now() + seconds * 1000,
		});
		return new Response(null, {
			status: 303,
			headers: {
				location: "/",
				"set-cookie": cookie(id, seconds),
				"cache-control": "no-store",
			},
		});
	};
}
