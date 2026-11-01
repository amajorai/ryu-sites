import { z } from "zod";
import { siteDataValueSchema } from "../../sidecar/src/data-values.ts";
import { siteExtensions } from "../../sidecar/src/extensions.ts";
export const sitesCallsSchema = z.array(
	z.object({
		body: siteDataValueSchema.optional(),
		method: z.string(),
		path: z.string(),
		response: siteDataValueSchema.optional(),
		status: z.number(),
	})
);
export const extensionsWriteSchema = z.object({
	expectedRevision: z.number(),
	extensions: siteExtensions,
});
export const extensionsEvidenceSchema = z.object({
	connectorInvocations: z.number(),
	managementCalls: z.array(
		z.object({
			body: siteDataValueSchema.optional(),
			method: z.string(),
			ownerBearerForwarded: z.boolean(),
			path: z.string(),
			status: z.number().optional(),
		})
	),
	unknownRequests: z.array(z.string()),
});
