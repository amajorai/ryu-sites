import { join } from "node:path";
import { createSitesServer } from "../../sidecar/src/server.ts";
import { SitesStore } from "../../sidecar/src/store.ts";
import { visitorScript } from "../../sidecar/src/visitor-bundle.ts";

const dataDirectory = Bun.env.RYU_SITES_TEST_DATA_DIR;
if (!dataDirectory) {
	throw new Error("Sites E2E needs an isolated data directory.");
}

const store = new SitesStore(join(dataDirectory, "sites.sqlite"));
const server = createSitesServer({
	baseDomain: "localhost",
	ownerId: "sites-playwright-owner",
	port: Number(Bun.env.RYU_SITES_PORT ?? "8423"),
	publicEnabled: true,
	services: {
		// Custom domains need an operator edge (domainsAvailable). This fixture
		// edge never confirms a TLS binding, so domains stay pending.
		domainReady: async () => false,
		resolveDomainTxtRecords: async () => [],
		scanArtifact: async (html) => {
			const hasDocumentType = /^\s*<!doctype html/i.test(html);
			const containsSecret =
				/(?:api[_-]?key|authorization)\s*[:=]\s*["']?(?:sk-|ghp_)/i.test(html);
			return {
				allowed: hasDocumentType && !containsSecret,
				reason:
					hasDocumentType && !containsSecret
						? null
						: "The local Sites fixture rejected an incompatible or secret-bearing artifact.",
			};
		},
	},
	store,
	token: Bun.env.RYU_SITES_TEST_TOKEN ?? "sites-playwright-local-token",
	visitorPort: Number(Bun.env.RYU_SITES_VISITOR_PORT ?? "8422"),
	visitorScript,
});

// This sidecar is isolated to the E2E temp directory and synthetic token.
function stop(): void {
	server.stop();
	store.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.info("[sites-e2e] local Sites sidecar ready");
