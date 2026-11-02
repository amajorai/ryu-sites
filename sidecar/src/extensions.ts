import { z } from "zod";

export const siteTool = z
	.object({
		name: z
			.string()
			.regex(/^[a-z][a-z0-9_]{0,63}$/)
			.refine(
				(name) => name !== "ryu_site_context",
				"This tool name is reserved for Site views"
			),
		description: z.string().trim().min(1).max(500),
		operation: z.enum([
			"records.list",
			"records.set",
			"records.delete",
			"knowledge.search",
		]),
		collection: z
			.string()
			.regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
			.default("data"),
	})
	.strict();
export const siteExtensions = z
	.object({
		mcp: z.boolean().default(false),
		ui: z.boolean().default(false),
		tools: z
			.array(siteTool)
			.max(20)
			.default([])
			.refine(
				(tools) =>
					new Set(tools.map((tool) => tool.name)).size === tools.length,
				"Tool names must be unique"
			),
		connections: z.array(z.string().min(1).max(100)).max(20).default([]),
	})
	.strict()
	.default({ mcp: false, ui: false, tools: [], connections: [] });
export type SiteExtensions = z.infer<typeof siteExtensions>;
export type SiteTool = z.infer<typeof siteTool>;

/** Operator policy, never a visitor-supplied URL, credential, or identity. */
export const approvedConnection = z
	.object({
		id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/),
		label: z.string().min(1).max(100),
		toolId: z.string().min(1).max(200),
		agentId: z.string().min(1).max(100),
		readOnly: z.boolean(),
	})
	.strict();
export type ApprovedConnection = z.infer<typeof approvedConnection>;
export const toolArguments = {
	"records.list": z.object({}).strict(),
	"records.set": z
		.object({
			key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
			value: z.json(),
		})
		.strict(),
	"records.delete": z
		.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/) })
		.strict(),
	"knowledge.search": z
		.object({ query: z.string().trim().min(1).max(2000) })
		.strict(),
};
export function describeSiteTool(tool: SiteTool) {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: z.toJSONSchema(toolArguments[tool.operation]),
		annotations: {
			readOnlyHint:
				tool.operation === "records.list" ||
				tool.operation === "knowledge.search",
			destructiveHint: tool.operation === "records.delete",
			idempotentHint: true,
			openWorldHint: false,
		},
	};
}
