/**
 * The injectable services and options of the Sites management and visitor
 * listeners. `./server.ts` re-exports them; import from there.
 */
import type {
	ResetActionResult,
	ResetProvider,
	SitePrincipal,
} from "./contracts.ts";
import type { SiteDataRecord, SiteDataValue } from "./data-values.ts";
import type { sitePlugin as nativeSitePlugin } from "./extension-routes.ts";
import type { ApprovedConnection } from "./extensions.ts";
import type { OwnerConnectionPolicy } from "./owner-connections.ts";
import type { SitesSpacesDatabase } from "./spaces-database.ts";
import type { SitesStore } from "./store.ts";

export interface SitesServices {
	answer?: (
		siteId: string,
		spaceId: string,
		query: string
	) => Promise<SiteDataValue>;
	authorizationServer?: string;
	canBindSpace?: (siteId: string, spaceId: string) => boolean;
	/**
	 * General in-page AI through the host's model. Receives the composed
	 * system text and prompt; must throw rather than return invented text.
	 */
	complete?: (input: { system: string; prompt: string }) => Promise<string>;
	connections?: (siteId: string) => ApprovedConnection[];
	/** Checks actual TLS/edge binding, not just a successful DNS lookup. */
	domainReady?: (siteId: string, host: string) => Promise<boolean>;
	/** Platform-verified identity. Never read user identity from arbitrary headers. */
	identity?: (request: Request) => Promise<SitePrincipal | null>;
	installPlugin?: (
		manifest: ReturnType<typeof nativeSitePlugin> & { update?: boolean },
		request: Request
	) => Promise<SiteDataValue>;
	invokeConnection?: (input: {
		request: Request;
		connection: ApprovedConnection;
		arguments: SiteDataRecord;
	}) => Promise<SiteDataValue>;
	managementIdentity?: (request: Request) => Promise<SitePrincipal | null>;
	mcpIdentity?: (request: Request) => Promise<SitePrincipal | null>;
	/** Operator policy for owner-managed connections; defaults to allowed. */
	ownerConnectionPolicy?: () => OwnerConnectionPolicy;
	/** Resolves the ownership TXT record; defaults to the system DNS resolver. */
	resolveDomainTxtRecords?: (recordName: string) => Promise<string[][]>;
	retrieve?: (
		siteId: string,
		spaceId: string,
		query: string
	) => Promise<SiteDataValue>;
	runResetAction?: (input: {
		ownerId: string;
		provider: ResetProvider;
		siteId: string;
	}) => Promise<ResetActionResult>;
	scanArtifact?: (
		html: string
	) => Promise<{ allowed: boolean; reason: string | null }>;
	signIn?: (request: Request) => Promise<Response | null>;
	spacesDatabase?: SitesSpacesDatabase;
}
export interface ServerOptions {
	baseDomain?: string;
	/**
	 * Standalone `GET /` redirect target. Without one, the home describes the
	 * service instead of sending people anywhere.
	 */
	dashboardUrl?: string | null;
	/** Management bind address; loopback unless a standalone bearer guards it. */
	hostname?: string;
	/**
	 * Per-process secret behind `GET /api/sites/instance-proof`, which lets the
	 * MCP lane confirm it reached this sidecar before sending its bearer.
	 * Without one the route answers 404.
	 */
	instanceSecret?: string;
	/** `core` (default) is the Core-managed sidecar; `standalone` serves its own API. */
	mode?: "core" | "standalone";
	ownerId?: string;
	port?: number;
	/**
	 * Stamp the "Powered by Ryu" badge on every published page. The sidecar sets
	 * it from the owner's plan (`RYU_BRANDING_REMOVABLE`); off when omitted so a
	 * server built for a test serves the artifact byte-for-byte.
	 */
	poweredByRyu?: boolean;
	publicEnabled?: boolean;
	services?: SitesServices;
	store: SitesStore;
	token: string | null;
	/** Proxy addresses or CIDRs whose `X-Forwarded-For` names the visitor. */
	trustedProxies?: readonly string[];
	/** Visitor bind address; defaults to loopback. */
	visitorHostname?: string;
	visitorPort?: number;
	visitorScript?: string;
}
