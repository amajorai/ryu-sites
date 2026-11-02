import { isIP } from "node:net";
import {
	resolveSidecarToken,
	type SidecarEnvironment,
} from "@ryu/sidecar-runtime";
import { parseAddress } from "./client-address.ts";

/** Shortest standalone management bearer Sites accepts. */
export const SITES_API_TOKEN_MIN_LENGTH = 32;
/** Example values from docs and templates that must never guard Sites. */
const PLACEHOLDER_TOKENS = new Set([
	"change-me",
	"changeme",
	"replace-me",
	"secret",
	"sites-example-secret",
	"token",
]);

export type SitesMode = "core" | "standalone";

export interface SitesGatewayConfig {
	/** Bearer for the Gateway's `/v1/firewall/check`; optional for a keyless Gateway. */
	key: string | null;
	/** Gateway base URL; HTTPS, or HTTP to a loopback host only. */
	url: string;
}

export interface SitesProcessConfig {
	/** Core host bridge port. Always null in standalone mode. */
	corePort: number | null;
	/**
	 * Standalone `GET /` redirect target. Null unless the operator sets
	 * `RYU_PRODUCT_DASHBOARD_URL`, so a self-hosted Sites never sends people
	 * to a Ryu-hosted page by default.
	 */
	dashboardUrl: string | null;
	gateway: SitesGatewayConfig | null;
	hostname: string;
	mode: SitesMode;
	/** The management bearer this process accepts. */
	token: string;
	visitorHostname: string;
	/** Non-fatal configuration notes to log at startup. */
	warnings: string[];
}

function value(env: SidecarEnvironment, name: string): string | null {
	const raw = env[name]?.trim();
	return raw ? raw : null;
}

/** True for 127.0.0.0/8, `::1` and IPv4-mapped loopback addresses. */
export function isLoopbackAddress(address: string): boolean {
	if (isIP(address) === 0) {
		return false;
	}
	const parsed = parseAddress(address);
	if (!parsed) {
		return false;
	}
	return parsed.bits === 32
		? parsed.value >> 24n === 127n
		: parsed.value === 1n;
}

function bindAddress(env: SidecarEnvironment, name: string): string {
	const address = value(env, name) ?? "127.0.0.1";
	if (isIP(address) === 0) {
		throw new Error(`${name} must be an IP address, such as 127.0.0.1`);
	}
	return address;
}

function weakToken(token: string): boolean {
	return (
		token.length < SITES_API_TOKEN_MIN_LENGTH ||
		PLACEHOLDER_TOKENS.has(token.toLowerCase())
	);
}

function gatewayConfig(env: SidecarEnvironment): SitesGatewayConfig | null {
	const raw = value(env, "RYU_SITES_GATEWAY_URL");
	const key = value(env, "RYU_SITES_GATEWAY_KEY");
	if (!raw) {
		if (key) {
			throw new Error("RYU_SITES_GATEWAY_KEY requires RYU_SITES_GATEWAY_URL");
		}
		return null;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("RYU_SITES_GATEWAY_URL must be an absolute URL");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const loopback = host === "localhost" || isLoopbackAddress(host);
	if (
		!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"RYU_SITES_GATEWAY_URL must be an HTTPS URL, or HTTP to a loopback Gateway, without credentials, query or fragment"
		);
	}
	return { url: url.href.replace(/\/+$/, ""), key };
}

function explicitMode(env: SidecarEnvironment): SitesMode | null {
	const mode = value(env, "RYU_SITES_MODE")?.toLowerCase() ?? null;
	if (mode === null || mode === "core" || mode === "standalone") {
		return mode;
	}
	throw new Error(
		`RYU_SITES_MODE must be 'core' or 'standalone', got '${mode}'`
	);
}

/**
 * Resolves how this process runs. The default is the Core-managed sidecar,
 * unchanged: Core mints the bearer and the listeners stay on loopback unless
 * the operator chooses otherwise. Standalone mode has its own management bearer
 * and never accepts, or calls Core with, a Core-minted token.
 */
export function resolveSitesProcessConfig(
	env: SidecarEnvironment
): SitesProcessConfig {
	const apiToken = value(env, "RYU_SITES_API_TOKEN");
	const coreTokenNames = ["RYU_EXT_TOKEN", "RYU_SITES_TOKEN"].filter((name) =>
		value(env, name)
	);
	const requested = explicitMode(env);
	let mode: SitesMode;
	if (requested === "core") {
		if (apiToken) {
			throw new Error(
				"RYU_SITES_MODE=core cannot be combined with RYU_SITES_API_TOKEN"
			);
		}
		mode = "core";
	} else if (requested === "standalone") {
		if (!apiToken || coreTokenNames.length > 0) {
			throw new Error(
				"RYU_SITES_MODE=standalone requires RYU_SITES_API_TOKEN and rejects Core tokens (RYU_EXT_TOKEN, RYU_SITES_TOKEN)"
			);
		}
		mode = "standalone";
	} else if (apiToken) {
		if (coreTokenNames.length > 0) {
			throw new Error(
				"RYU_SITES_API_TOKEN cannot be combined with Core tokens (RYU_EXT_TOKEN, RYU_SITES_TOKEN)"
			);
		}
		mode = "standalone";
	} else {
		mode = "core";
	}

	const hostname = bindAddress(env, "RYU_SITES_HOSTNAME");
	const visitorHostname = bindAddress(env, "RYU_SITES_VISITOR_HOSTNAME");
	if (!isLoopbackAddress(hostname) && mode !== "standalone") {
		throw new Error(
			"Refusing a non-loopback Sites management bind without RYU_SITES_API_TOKEN; Core tokens are not standalone credentials"
		);
	}
	const gateway = gatewayConfig(env);
	const warnings: string[] = [];

	if (mode === "core") {
		if (gateway) {
			throw new Error(
				"RYU_SITES_GATEWAY_URL applies only to RYU_SITES_MODE=standalone; Core-managed Sites scans through Core"
			);
		}
		const token = resolveSidecarToken(env, "RYU_SITES_TOKEN");
		if (!token) {
			throw new Error("Sites requires its Core-minted extension token");
		}
		const corePort = Number(env.RYU_CORE_PORT);
		return {
			corePort: Number.isInteger(corePort) && corePort > 0 ? corePort : null,
			dashboardUrl: null,
			gateway: null,
			hostname,
			mode,
			token,
			visitorHostname,
			warnings,
		};
	}

	const token = apiToken ?? "";
	if (weakToken(token)) {
		throw new Error(
			`RYU_SITES_API_TOKEN must be at least ${SITES_API_TOKEN_MIN_LENGTH} characters and not a placeholder; generate one with \`openssl rand -hex 32\``
		);
	}
	if (value(env, "RYU_CORE_PORT")) {
		warnings.push(
			"RYU_CORE_PORT is ignored in standalone mode; standalone Sites never calls Core"
		);
	}
	if (value(env, "RYU_SITES_OWNER_JWT")) {
		warnings.push(
			"RYU_SITES_OWNER_JWT is ignored in standalone mode; it only authorizes Core host calls"
		);
	}
	return {
		corePort: null,
		dashboardUrl: value(env, "RYU_PRODUCT_DASHBOARD_URL"),
		gateway,
		hostname,
		mode,
		token,
		visitorHostname,
		warnings,
	};
}
