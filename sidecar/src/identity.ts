import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
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
const pendingLoginSchema = z
	.object({
		expires: z.number(),
		nonce: z.string(),
		origin: z.string(),
		state: z.string(),
		verifier: z.string(),
	})
	.strict();
type PendingLogin = z.infer<typeof pendingLoginSchema>;
const LOGIN_SEAL_CONTEXT = Buffer.from("ryu-site-login-v1");
const LOGIN_TTL_MS = 600_000;
const CONSUMED_LOGIN_LIMIT = 10_000;
interface VisitorSession {
	expires: number;
	origin: string;
	user: SitePrincipal;
	userJwt: string | null;
}
/** OIDC client for the existing platform identity provider; no local account database. */
export class SitesIdentity {
	// Pending sign-ins live in the visitor's own sealed, HttpOnly login cookie,
	// so no shared server-side table can be filled to block other visitors.
	private readonly loginKey = randomBytes(32);
	// Completed states are remembered only to refuse a replayed callback.
	private readonly consumedLogins = new Map<string, number>();
	private readonly sessions = new Map<string, VisitorSession>();
	private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
	private constructor(
		private readonly config: {
			issuer: string;
			clientId: string;
			clientSecret?: string;
			toolAudience?: string;
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
		toolAudience?: string;
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
	private loginCookieName(origin: string) {
		return origin.startsWith("https:")
			? "__Host-ryu-site-login"
			: "ryu-site-login";
	}
	private cookie(request: Request): string | undefined {
		return this.cookieValue(
			request,
			this.cookieName(new URL(request.url).origin)
		);
	}
	private cookieValue(request: Request, name: string): string | undefined {
		return request.headers
			.get("cookie")
			?.split(";")
			.map((value) => value.trim())
			.find((value) => value.startsWith(`${name}=`))
			?.slice(name.length + 1);
	}
	private sealLogin(login: PendingLogin): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.loginKey, iv);
		cipher.setAAD(LOGIN_SEAL_CONTEXT);
		const sealed = Buffer.concat([
			cipher.update(JSON.stringify(login), "utf8"),
			cipher.final(),
		]);
		return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString(
			"base64url"
		);
	}
	private openLogin(value: string | undefined): PendingLogin | null {
		if (!value || value.length > 4096) {
			return null;
		}
		try {
			const bytes = Buffer.from(value, "base64url");
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.loginKey,
				bytes.subarray(0, 12)
			);
			decipher.setAAD(LOGIN_SEAL_CONTEXT);
			decipher.setAuthTag(bytes.subarray(12, 28));
			const plain = Buffer.concat([
				decipher.update(bytes.subarray(28)),
				decipher.final(),
			]).toString("utf8");
			return pendingLoginSchema.parse(JSON.parse(plain));
		} catch {
			return null;
		}
	}
	private consumeLogin(login: PendingLogin): boolean {
		const now = Date.now();
		for (const [state, expires] of this.consumedLogins) {
			if (expires <= now) {
				this.consumedLogins.delete(state);
			}
		}
		if (this.consumedLogins.has(login.state)) {
			return false;
		}
		// Evicting the oldest entry never blocks a sign-in; the identity
		// provider's single-use authorization code still refuses a replay.
		const oldest = this.consumedLogins.keys().next();
		if (this.consumedLogins.size >= CONSUMED_LOGIN_LIMIT && !oldest.done) {
			this.consumedLogins.delete(oldest.value);
		}
		this.consumedLogins.set(login.state, login.expires);
		return true;
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
	/** Server-only identity proof; never returned to a visitor or Site artifact. */
	userJwt = async (request: Request): Promise<string | null> => {
		const user = await this.identity(request);
		if (!(user && this.config.toolAudience)) {
			return null;
		}
		const id = this.cookie(request);
		const token = id ? this.sessions.get(id)?.userJwt : null;
		if (!token) {
			return null;
		}
		try {
			const { payload } = await jwtVerify(token, this.jwks, {
				issuer: this.config.issuer,
				audience: this.config.toolAudience,
				requiredClaims: ["exp", "iat"],
			});
			return (payload.id ?? payload.sub) === user.id ? token : null;
		} catch {
			return null;
		}
	};
	mcpIdentity = async (request: Request): Promise<SitePrincipal | null> => {
		const token = request.headers
			.get("authorization")
			?.match(/^Bearer (\S+)$/)?.[1];
		if (!token) {
			return null;
		}
		try {
			const { payload } = await jwtVerify(token, this.jwks, {
				issuer: this.config.issuer,
				audience: new URL(request.url).href,
				requiredClaims: ["sub", "exp", "iat"],
			});
			if (payload.email_verified !== true) {
				return null;
			}
			return {
				id: z.string().min(1).parse(payload.sub),
				email: z.string().email().parse(payload.email).toLowerCase(),
				workspaceIds: z
					.array(z.string())
					.catch(() => [])
					.parse(payload.workspaceIds),
			};
		} catch {
			return null;
		}
	};
	handle = async (request: Request): Promise<Response | null> => {
		const url = new URL(request.url);
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
		const loginCookie = (value: string, seconds: number) =>
			`${this.loginCookieName(url.origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${url.protocol === "https:" ? "; Secure" : ""}`;
		if (url.pathname === "/_ryu/signin" && request.method === "GET") {
			const state = crypto.randomUUID();
			const verifier =
				`${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
			const nonce = crypto.randomUUID();
			const sealed = this.sealLogin({
				verifier,
				nonce,
				origin: url.origin,
				state,
				expires: Date.now() + LOGIN_TTL_MS,
			});
			const destination = new URL(this.discovery.authorization_endpoint);
			const authorizationParameters = new URLSearchParams({
				client_id: this.config.clientId,
				response_type: "code",
				scope: "openid email profile",
			});
			if (this.config.toolAudience) {
				authorizationParameters.set("resource", this.config.toolAudience);
			}
			authorizationParameters.set(
				"redirect_uri",
				`${url.origin}/_ryu/callback`
			);
			authorizationParameters.set("state", state);
			authorizationParameters.set("nonce", nonce);
			authorizationParameters.set(
				"code_challenge",
				createHash("sha256").update(verifier).digest("base64url")
			);
			authorizationParameters.set("code_challenge_method", "S256");
			destination.search = authorizationParameters.toString();
			return new Response(null, {
				status: 302,
				headers: {
					location: destination.toString(),
					"set-cookie": loginCookie(sealed, LOGIN_TTL_MS / 1000),
					"cache-control": "no-store",
				},
			});
		}
		if (url.pathname !== "/_ryu/callback" || request.method !== "GET") {
			return null;
		}
		const state = url.searchParams.get("state") ?? "";
		const pending = this.openLogin(
			this.cookieValue(request, this.loginCookieName(url.origin))
		);
		if (
			!pending ||
			pending.origin !== url.origin ||
			pending.state !== state ||
			pending.expires <= Date.now() ||
			!this.consumeLogin(pending)
		) {
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
		if (this.config.toolAudience) {
			parameters.set("resource", this.config.toolAudience);
		}
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
			.object({ id_token: z.string(), access_token: z.string().optional() })
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
			.catch(() => [])
			.parse(payload.workspaceIds);
		this.sessions.set(id, {
			// An ID token authenticates the Site session. It must NEVER be reused
			// as an access token for Core, whose audience/permission checks differ.
			userJwt: tokens.access_token ?? null,
			user: { id: payload.sub ?? "", email, workspaceIds },
			origin: url.origin,
			expires: Date.now() + seconds * 1000,
		});
		const headers = new Headers({
			location: "/",
			"cache-control": "no-store",
		});
		headers.append("set-cookie", cookie(id, seconds));
		headers.append("set-cookie", loginCookie("", 0));
		return new Response(null, { status: 303, headers });
	};
}
