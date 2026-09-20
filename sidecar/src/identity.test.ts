import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SitesIdentity } from "./identity.ts";

test("OIDC verifies nonce, signature and audience and scopes a session to its site origin", async () => {
	const keys = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(keys.publicKey)),
		kid: "test-key",
		alg: "RS256",
		use: "sig",
	};
	let nonce = "";
	let audience = "sites-client";
	const fetchImpl = Object.assign(
		async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			const url = String(input);
			if (url.endsWith("openid-configuration")) {
				return Response.json({
					issuer: "https://identity.example",
					authorization_endpoint: "https://identity.example/authorize",
					token_endpoint: "https://identity.example/token",
					jwks_uri: "https://identity.example/keys",
				});
			}
			if (url.endsWith("/keys")) {
				return Response.json({ keys: [jwk] });
			}
			if (url.endsWith("/token")) {
				const params = new URLSearchParams(String(init?.body));
				if (!params.get("code_verifier")) {
					throw new Error("PKCE verifier missing");
				}
				const token = await new SignJWT({
					nonce,
					email: "VIEWER@example.com",
					email_verified: true,
					workspaceIds: ["workspace"],
				})
					.setProtectedHeader({ alg: "RS256", kid: "test-key" })
					.setIssuer("https://identity.example")
					.setAudience(audience)
					.setSubject("viewer")
					.setIssuedAt()
					.setExpirationTime("5m")
					.sign(keys.privateKey);
				return Response.json({ id_token: token });
			}
			throw new Error("Unexpected identity endpoint");
		},
		{ preconnect: fetch.preconnect }
	);
	const identity = await SitesIdentity.connect({
		issuer: "https://identity.example",
		clientId: "sites-client",
		fetchImpl,
	});
	const begin = await identity.handle(
		new Request("https://first.example/_ryu/signin")
	);
	const destination = new URL(begin?.headers.get("location") ?? "");
	nonce = destination.searchParams.get("nonce") ?? "";
	const state = destination.searchParams.get("state") ?? "";
	expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
	const callback = new Request(
		`https://first.example/_ryu/callback?code=approved&state=${state}`,
		{ headers: { cookie: `ryu-site-login=${state}` } }
	);
	const result = await identity.handle(callback);
	expect(result?.status).toBe(303);
	const setCookie = result?.headers.get("set-cookie") ?? "";
	expect(setCookie).toContain("__Host-ryu-site-session=");
	expect(setCookie).toContain("HttpOnly");
	expect(setCookie).toContain("Secure");
	const cookie = setCookie.split(";")[0] ?? "";
	expect(
		await identity.identity(
			new Request("https://first.example/", { headers: { cookie } })
		)
	).toEqual({
		id: "viewer",
		email: "viewer@example.com",
		workspaceIds: ["workspace"],
	});
	expect(
		await identity.identity(
			new Request("https://second.example/", { headers: { cookie } })
		)
	).toBeNull();
	await expect(identity.handle(callback)).rejects.toThrow("expired");
	const mismatched = await identity.handle(
		new Request("https://first.example/_ryu/signin")
	);
	const mismatchUrl = new URL(mismatched?.headers.get("location") ?? "");
	const mismatchState = mismatchUrl.searchParams.get("state") ?? "";
	nonce = "wrong-nonce";
	await expect(
		identity.handle(
			new Request(
				`https://first.example/_ryu/callback?code=approved&state=${mismatchState}`,
				{ headers: { cookie: `ryu-site-login=${mismatchState}` } }
			)
		)
	).rejects.toThrow("verified email identity");
	const wrongAudience = await identity.handle(
		new Request("https://first.example/_ryu/signin")
	);
	const audienceUrl = new URL(wrongAudience?.headers.get("location") ?? "");
	const audienceState = audienceUrl.searchParams.get("state") ?? "";
	nonce = audienceUrl.searchParams.get("nonce") ?? "";
	audience = "another-app";
	await expect(
		identity.handle(
			new Request(
				`https://first.example/_ryu/callback?code=approved&state=${audienceState}`,
				{ headers: { cookie: `ryu-site-login=${audienceState}` } }
			)
		)
	).rejects.toThrow();
});

test("identity discovery rejects non-HTTPS issuers before sending requests", async () => {
	await expect(
		SitesIdentity.connect({
			issuer: "http://identity.example",
			clientId: "sites",
		})
	).rejects.toThrow("HTTPS");
});
