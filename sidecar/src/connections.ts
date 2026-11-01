import { createSidecarHostClient } from "@ryu/sidecar-runtime";
import { z } from "zod";
import { type SiteDataRecord, siteDataValueSchema } from "./data-values.ts";
import type { ApprovedConnection } from "./extensions.ts";
import { SiteError } from "./store.ts";

export function createSitesConnections(options: {
	corePort: number;
	token: string;
	bindings: () => Record<string, ApprovedConnection[]>;
	userJwt: (request: Request) => Promise<string | null>;
	fetchImpl?: typeof fetch;
}) {
	const host = createSidecarHostClient({ ...options, pluginId: "@ryu/sites" });
	return {
		connections: (siteId: string) => options.bindings()[siteId] ?? [],
		async invokeConnection(input: {
			request: Request;
			connection: ApprovedConnection;
			arguments: SiteDataRecord;
		}) {
			const jwt = await options.userJwt(input.request);
			if (!jwt) {
				throw new SiteError(
					"unauthorized",
					"Sign in again to use this connection",
					401
				);
			}
			const result = await host.capability(
				"tools.call",
				{
					tool: input.connection.toolId,
					agentId: input.connection.agentId,
					arguments: z
						.json()
						.parse(JSON.parse(JSON.stringify(input.arguments))),
				},
				jwt
			);
			const decoded = z
				.object({ ok: z.literal(true), output: siteDataValueSchema })
				.refine((reply) => "output" in reply)
				.safeParse(result);
			if (!decoded.success) {
				throw new SiteError(
					"tool_error",
					"The tool did not complete. Check its state before retrying.",
					502
				);
			}
			if (
				z
					.object({ __ryu_elicitation__: siteDataValueSchema })
					.refine((reply) => "__ryu_elicitation__" in reply)
					.safeParse(decoded.data.output).success
			) {
				throw new SiteError(
					"approval_required",
					"Complete this tool's approval or connection in Ryu before trying again.",
					409
				);
			}
			if (
				z.object({ isError: z.literal(true) }).safeParse(decoded.data.output)
					.success
			) {
				throw new SiteError(
					"tool_error",
					"The provider reported an error. Check its state before retrying.",
					502
				);
			}
			return decoded.data.output;
		},
	};
}
