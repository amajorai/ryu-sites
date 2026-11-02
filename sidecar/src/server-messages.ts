import { fail } from "./server-http.ts";

/** The settings that need verified platform identity before they turn on. */
export type IdentityPurpose = "sharedData" | "resetActions" | "sharing";

/**
 * Refuses a setting that needs verified identity. Core connects platform
 * identity itself; a standalone operator sets the process's OpenID Connect
 * client instead, so name those settings. Whole sentences per purpose and
 * mode, so the catalog holds each one complete instead of an English purpose
 * spliced into a frame.
 */
export function identityRequired(
	standalone: boolean,
	purpose: IdentityPurpose
): never {
	if (purpose === "sharedData") {
		return standalone
			? fail(
					"unavailable",
					"Set RYU_SITES_ISSUER and RYU_SITES_CLIENT_ID (OpenID Connect sign-in) on the Sites process before enabling shared data",
					503
				)
			: fail(
					"unavailable",
					"Connect platform identity before enabling shared data",
					503
				);
	}
	if (purpose === "resetActions") {
		return standalone
			? fail(
					"unavailable",
					"Set RYU_SITES_ISSUER and RYU_SITES_CLIENT_ID (OpenID Connect sign-in) on the Sites process before enabling owner reset actions",
					503
				)
			: fail(
					"unavailable",
					"Connect platform identity before enabling owner reset actions",
					503
				);
	}
	return standalone
		? fail(
				"unavailable",
				"Set RYU_SITES_ISSUER and RYU_SITES_CLIENT_ID (OpenID Connect sign-in) on the Sites process before enabling sharing or sign-in",
				503
			)
		: fail(
				"unavailable",
				"Connect platform identity before enabling sharing or sign-in",
				503
			);
}
