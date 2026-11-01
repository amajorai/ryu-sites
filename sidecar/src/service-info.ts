/** Identity of the Sites service, reported by its home and status routes. */
import sitesManifest from "../../manifest.json" with { type: "json" };

/** Version of the `/api/sites/*` contract, reported by the status route. */
export const SITES_API_VERSION = "v1";
export const SITES_SERVICE_NAME = "ryu-sites";
/** The Sites release, from the satellite manifest the release train stamps. */
export const SITES_SERVICE_VERSION = sitesManifest.version;
