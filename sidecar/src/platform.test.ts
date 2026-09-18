import { expect, test } from "bun:test";
import { createSitesRetrieval } from "./platform.ts";

test("Sites searches only the bound Space through the canonical host search operation", async () => {
	const calls: unknown[] = [];
	const fetchImpl = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			calls.push(JSON.parse(String(init?.body)));
			return Response.json({
				result: {
					space_id: "approved",
					matches: [
						{
							chunk_id: "citation",
							content: "A grounded passage",
							distance: 0,
							document_id: "private-id",
							token: "never-export",
						},
					],
				},
			});
		},
		{ preconnect: fetch.preconnect }
	);
	const platform = createSitesRetrieval({
		corePort: 7980,
		token: "extension-token",
		bindings: { siteA: ["approved"] },
		fetchImpl,
	});
	expect(await platform.retrieve("siteA", "approved", "question")).toEqual([
		{ id: "citation", text: "A grounded passage", score: 1 },
	]);
	expect(calls).toEqual([
		{
			method: "spaces.search",
			args: { space_id: "approved", query: "question", limit: 8 },
		},
	]);
	await expect(
		platform.retrieve("siteB", "approved", "question")
	).rejects.toThrow("not approved");
	await expect(
		platform.retrieve("siteA", "another-space", "question")
	).rejects.toThrow("not approved");
	expect(calls).toHaveLength(1);
});
