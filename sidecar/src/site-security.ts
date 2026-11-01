/**
 * The pre-deploy security report for one saved Site version: the secret
 * scanner's verdict plus the runtime protections every Site gets.
 */
import { createHash } from "node:crypto";
import type { RuntimeSite } from "./contracts.ts";
import type { SitesServices } from "./server-types.ts";
import type { SitesStore } from "./store.ts";

export async function inspectSiteSecurity(
	site: RuntimeSite,
	versionId: string,
	store: SitesStore,
	services: SitesServices
) {
	const html = store.artifact(site.id, versionId);
	const artifactDigest = createHash("sha256").update(html).digest("hex");
	let status: "passed" | "blocked" | "unavailable" = "unavailable";
	let summary =
		"The Gateway secret scanner is unavailable. Deployment is blocked.";
	if (services.scanArtifact) {
		try {
			const result = await services.scanArtifact(html);
			status = result.allowed ? "passed" : "blocked";
			summary = result.allowed
				? "No known secret patterns detected in this saved version."
				: "A potential secret was detected. Remove it from the site before deploying.";
		} catch {
			/* An unavailable scanner never becomes a passed check. */
		}
	}
	return {
		versionId,
		artifactDigest,
		checkedAt: new Date().toISOString(),
		status,
		summary,
		protections: [
			{
				name: "Separate visitor origin",
				detail:
					"Generated pages cannot access the Companion or its credentials.",
			},
			{
				name: "Restricted browser capabilities",
				detail:
					"External scripts, styles, fonts, frames, form posts and fetch or WebSocket calls, embedding, camera, microphone and location are blocked by default. Links, page navigation and some browser peer-connection features can still reach other sites.",
			},
			{
				name: "Server-side data permissions",
				detail:
					"Durable records and files require verified identity and remain scoped to the site and visitor.",
			},
			{
				name: "Bounded requests and uploads",
				detail: "The service enforces request, storage and file-size limits.",
			},
		],
		limitation:
			"This checks known secret patterns and runtime posture. It is not a complete code audit, penetration test or compliance certification.",
	};
}
