import { z } from "zod";
import { remixableSite } from "../../sidecar/src/contracts.ts";
import { siteDataValueSchema } from "../../sidecar/src/data-values.ts";
import { approvedConnection } from "../../sidecar/src/extensions.ts";
import {
	ownerConnectionRecordSchema,
	siteExtensionsRecordSchema,
} from "../../sidecar/src/site-records.ts";

export {
	runtimeSiteSchema,
	runtimeSitesSchema,
} from "../../sidecar/src/site-records.ts";

function unchanged<T>(schema: z.ZodType<T>): z.ZodType<T> {
	return z.custom<T>((cause) => schema.safeParse(cause).success);
}
const serviceStatusSchemaContract = z.object({
	limits: z
		.object({
			projects: z.number(),
			versions: z.number(),
			totalArtifactBytes: z.number(),
			databaseBytes: z.number(),
			recordBytes: z.number(),
			records: z.number(),
			fileBytes: z.number(),
			files: z.number(),
		})
		.optional(),
	agentAvailable: z.boolean(),
	answersAvailable: z.boolean(),
	baseDomain: z.string(),
	completionsAvailable: z.boolean().optional(),
	connectionsAvailable: z.boolean(),
	databaseAvailable: z.boolean(),
	domainsAvailable: z.boolean().optional(),
	identityAvailable: z.boolean(),
	mcpAvailable: z.boolean(),
	mcpUiAvailable: z.boolean(),
	ownerConnectionsAvailable: z.boolean().optional(),
	pluginInstallAvailable: z.boolean(),
	publicEnabled: z.boolean(),
	retrievalAvailable: z.boolean(),
	scannerAvailable: z.boolean(),
	visitorPort: z.number(),
});
const runtimeScriptSchemaContract = z.object({ script: z.string() });
const artifactSchemaContract = z.object({ html: z.string() });
const resetActionResultSchemaContract = z.object({
	detail: z.string(),
	provider: z.enum(["codex", "claude", "copilot"]),
	status: z.literal("completed"),
});
const traffic = { pageViews: z.number(), uniqueVisitors: z.number() };
const analyticsReportSchemaContract = z.object({
	daily: z.array(z.object({ day: z.string(), ...traffic })),
	summary: z.object(traffic),
	topPages: z.array(z.object({ path: z.string(), ...traffic })),
});
const securityReportSchemaContract = z.object({
	artifactDigest: z.string(),
	checkedAt: z.string(),
	limitation: z.string(),
	protections: z.array(z.object({ name: z.string(), detail: z.string() })),
	status: z.enum(["passed", "blocked", "unavailable"]),
	summary: z.string(),
	versionId: z.string(),
});
const databaseSnapshotSchemaContract = z.object({
	connected: z.boolean(),
	database: z
		.object({ databaseId: z.string(), spaceId: z.string() })
		.optional(),
	records: z.number().optional(),
	sharedRecords: z.number().optional(),
});
const queryResultSchemaContract = z.object({
	columns: z.array(z.string()),
	rows: z.array(z.array(siteDataValueSchema)),
	schema: z.array(
		z.object({ id: z.string(), label: z.string(), name: z.string() })
	),
	truncated: z.boolean(),
});
const extensionStatusSchemaContract = z.object({
	connections: z.array(approvedConnection),
	plugin: z.object({
		id: z.string(),
		name: z.string(),
		version: z.string(),
		description: z.string(),
		engines: z.object({ ryu: z.string() }),
		permission_grants: z.array(z.string()),
		mcp_servers: z.object({
			site: z.object({
				type: z.literal("streamable-http"),
				url: z.string(),
				auth: z.object({ type: z.literal("oauth") }),
			}),
		}),
	}),
	published: siteExtensionsRecordSchema,
});
const ownerConnectionsStatusSchemaContract = z.object({
	available: z.boolean(),
	policy: z.object({
		enabled: z.boolean(),
		tools: z.array(z.string()).nullable(),
		agents: z.array(z.string()).default(() => ["ryu"]),
		readOnlyTools: z.array(z.string()).default(() => []),
	}),
	connections: z.array(
		ownerConnectionRecordSchema.extend({
			allowed: z.boolean(),
			publicId: z.string(),
			/** Read access only holds for tools the operator confirms are read-only. */
			effectiveReadOnly: z.boolean().optional(),
		})
	),
	operator: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			readOnly: z.boolean(),
			selected: z.boolean(),
		})
	),
});
const storedData = {
	files: z.number(),
	fileBytes: z.number(),
	records: z.number(),
};
const visitorDataReportSchemaContract = z.object({
	visitors: z.array(
		z.object({
			visitor: z.string(),
			owner: z.string(),
			recordBytes: z.number(),
			sharedRecords: z.number().optional(),
			...storedData,
		})
	),
	audit: z.array(
		z.object({
			action: z.string(),
			actor: z.string(),
			at: z.string(),
			visitor: z.string(),
			...storedData,
		})
	),
});
const visitorDataPurgeSchemaContract = z.object({
	visitor: z.string(),
	deleted: z.object(storedData),
});

export const serviceStatusSchema = unchanged(serviceStatusSchemaContract);
export const runtimeScriptSchema = unchanged(runtimeScriptSchemaContract);
export const artifactSchema = unchanged(artifactSchemaContract);
export const resetActionResultSchema = unchanged(
	resetActionResultSchemaContract
);
export const analyticsReportSchema = unchanged(analyticsReportSchemaContract);
export const securityReportSchema = unchanged(securityReportSchemaContract);
export const databaseSnapshotSchema = unchanged(databaseSnapshotSchemaContract);
export const queryResultSchema = unchanged(queryResultSchemaContract);
export const extensionStatusSchema = unchanged(extensionStatusSchemaContract);
export const ownerConnectionsStatusSchema = unchanged(
	ownerConnectionsStatusSchemaContract
);
export const visitorDataReportSchema = unchanged(
	visitorDataReportSchemaContract
);
export const visitorDataPurgeSchema = unchanged(visitorDataPurgeSchemaContract);
export const remixableSitesSchema = unchanged(remixableSite.array());

export type ServiceStatus = z.output<typeof serviceStatusSchema>;
export type AnalyticsReport = z.output<typeof analyticsReportSchema>;
export type SecurityReport = z.output<typeof securityReportSchema>;
export type SiteDatabaseSnapshot = z.output<typeof databaseSnapshotSchema>;
export type QueryResult = z.output<typeof queryResultSchema>;
export type ExtensionStatus = z.output<typeof extensionStatusSchema>;
export type OwnerConnectionsStatus = z.output<
	typeof ownerConnectionsStatusSchema
>;
export type VisitorDataReport = z.output<typeof visitorDataReportSchema>;
export type RemixableSites = z.output<typeof remixableSitesSchema>;
