import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SitesIdentity } from "./identity.ts";

/** The sealed login cookie a browser would send back on the callback. */
const loginCookie = (response: Response | null) =>
	response?.headers.get("set-cookie")?.split(";")[0] ?? "";

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
				const accessToken = await new SignJWT({
					id: "viewer",
					email: "viewer@example.com",
				})
					.setProtectedHeader({ alg: "RS256", kid: "test-key" })
					.setIssuer("https://identity.example")
					.setAudience("https://core.example")
					.setSubject("viewer")
					.setIssuedAt()
					.setExpirationTime("5m")
					.sign(keys.privateKey);
				return Response.json({ id_token: token, access_token: accessToken });
			}
			throw new Error("Unexpected identity endpoint");
		},
		{ preconnect: fetch.preconnect }
	);
	const identity = await SitesIdentity.connect({
		issuer: "https://identity.example",
		clientId: "sites-client",
		toolAudience: "https://core.example",
		fetchImpl,
	});
	const begin = await identity.handle(
		new Request("https://first.example/_ryu/signin")
	);
	const destination = new URL(begin?.headers.get("location") ?? "");
	nonce = destination.searchParams.get("nonce") ?? "";
	const state = destination.searchParams.get("state") ?? "";
	expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
	expect(begin?.headers.get("set-cookie")).toContain("__Host-ryu-site-login=");
	expect(begin?.headers.get("set-cookie")).toContain("Path=/; HttpOnly");
	expect(begin?.headers.get("set-cookie")).toContain("Secure");
	expect(loginCookie(begin)).not.toContain(state);
	const callback = new Request(
		`https://first.example/_ryu/callback?code=approved&state=${state}`,
		{ headers: { cookie: loginCookie(begin) } }
	);
	const result = await identity.handle(callback);
	expect(result?.status).toBe(303);
	expect(result?.headers.getSetCookie()).toContainEqual(
		expect.stringMatching(/^__Host-ryu-site-login=;.*Max-Age=0/)
	);
	const setCookie = result?.headers.get("set-cookie") ?? "";
	expect(setCookie).toContain("__Host-ryu-site-session=");
	expect(setCookie).toContain("HttpOnly");
	expect(setCookie).toContain("Secure");
	const cookie = setCookie.split(";")[0] ?? "";
	const userJwt = await identity.userJwt(
		new Request("https://first.example/", { headers: { cookie } })
	);
	expect(userJwt).toBeString();
	expect(
		await identity.userJwt(
			new Request("https://second.example/", { headers: { cookie } })
		)
	).toBeNull();
	const signedIdentity = await new SignJWT({
		email: "viewer@example.com",
		email_verified: true,
		workspaceIds: ["workspace"],
	})
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer("https://identity.example")
		.setAudience("https://first.example/mcp")
		.setSubject("viewer")
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(keys.privateKey);
	expect(
		await identity.mcpIdentity(
			new Request("https://first.example/mcp", {
				headers: { authorization: `Bearer ${signedIdentity}` },
			})
		)
	).toEqual({
		id: "viewer",
		email: "viewer@example.com",
		workspaceIds: ["workspace"],
	});
	expect(
		await identity.mcpIdentity(
			new Request("https://second.example/mcp", {
				headers: { authorization: `Bearer ${signedIdentity}` },
			})
		)
	).toBeNull();
	expect(
		await identity.mcpIdentity(
			new Request("https://first.example/mcp", { headers: { cookie } })
		)
	).toBeNull();
	expect(
		await identity.mcpIdentity(
			new Request("https://first.example/mcp", {
				headers: { authorization: "Bearer invalid" },
			})
		)
	).toBeNull();
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
	const planted = await identity.handle(
		new Request("https://first.example/_ryu/signin")
	);
	const plantedState =
		new URL(planted?.headers.get("location") ?? "").searchParams.get("state") ??
		"";
	await expect(
		identity.handle(
			new Request(
				`https://first.example/_ryu/callback?code=approved&state=${plantedState}`,
				{
					headers: { cookie: loginCookie(planted).replace("__Host-", "") },
				}
			)
		)
	).rejects.toThrow("did not match this browser");
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
				{ headers: { cookie: loginCookie(mismatched) } }
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
				{ headers: { cookie: loginCookie(wrongAudience) } }
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

test("pending sign-ins on one Site never block sign-in on another", async () => {
	const fetchImpl = Object.assign(
		async (input: Parameters<typeof fetch>[0]) => {
			if (String(input).endsWith("openid-configuration")) {
				return Response.json({
					issuer: "https://identity.example",
					authorization_endpoint: "https://identity.example/authorize",
					token_endpoint: "https://identity.example/token",
					jwks_uri: "https://identity.example/keys",
				});
			}
			throw new Error("Callbacks in this test must fail before token exchange");
		},
		{ preconnect: fetch.preconnect }
	);
	const identity = await SitesIdentity.connect({
		issuer: "https://identity.example",
		clientId: "sites-client",
		fetchImpl,
	});
	const statuses = new Set<number | undefined>();
	for (let index = 0; index < 1100; index += 1) {
		const flood = await identity.handle(
			new Request("https://attacker.example/_ryu/signin")
		);
		statuses.add(flood?.status);
	}
	expect([...statuses]).toEqual([302]);
	const victim = await identity.handle(
		new Request("https://victim.example/_ryu/signin")
	);
	expect(victim?.status).toBe(302);
	const victimState =
		new URL(victim?.headers.get("location") ?? "").searchParams.get("state") ??
		"";
	const attacker = await identity.handle(
		new Request("https://attacker.example/_ryu/signin")
	);
	const attackerState =
		new URL(attacker?.headers.get("location") ?? "").searchParams.get(
			"state"
		) ?? "";
	await expect(
		identity.handle(
			new Request(
				`https://victim.example/_ryu/callback?code=stolen&state=${attackerState}`,
				{ headers: { cookie: loginCookie(attacker) } }
			)
		)
	).rejects.toThrow("did not match this browser");
	// Change one character inside the sealed value (every middle base64url
	// character carries six data bits) so authentication must fail.
	const sealed = loginCookie(victim);
	const at = sealed.indexOf("=") + 30;
	const tampered = `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;
	await expect(
		identity.handle(
			new Request(
				`https://victim.example/_ryu/callback?code=approved&state=${victimState}`,
				{ headers: { cookie: tampered } }
			)
		)
	).rejects.toThrow("did not match this browser");
});
