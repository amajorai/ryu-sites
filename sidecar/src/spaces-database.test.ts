import { expect, test } from "bun:test";
import { z } from "zod";
import {
	type SiteDataRecord,
	siteDataRecordSchema,
	siteDataValueSchema,
} from "./data-values.ts";
import { createSitesSpacesDatabase } from "./spaces-database.ts";

test("Sites provisions and uses a private Ryu Spaces database document", async () => {
	let document = {
		id: "database-1",
		space_id: "space-1",
		title: "Site data",
		source: "",
		revision: 0,
		kind: "database" as const,
	};
	const calls: { method: string; args: SiteDataRecord }[] = [];

	const fetchImpl = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			const request = z
				.object({ args: siteDataRecordSchema, method: z.string() })
				.parse(JSON.parse(String(init?.body)));
			calls.push(request);
			switch (request.method) {
				case "spaces.ensureSpace":
					return Response.json({ result: "space-1" });
				case "spaces.listDatabases":
					return Response.json({
						result: [{ id: "database-1", title: "Site data", updated_at: 1 }],
					});
				case "spaces.getDatabase":
					return Response.json({ result: document });
				case "spaces.updateDatabase": {
					if (request.args.expected_revision !== document.revision) {
						return Response.json(
							{
								error: {
									code: "conflict",
									message: "database revision conflict",
								},
							},
							{ status: 409 }
						);
					}
					document = {
						...document,
						title: String(request.args.title),
						source: String(request.args.source),
						revision: document.revision + 1,
					};
					return Response.json({ result: { revision: document.revision } });
				}
				case "spaces.queryDatabase": {
					const source = z
						.object({
							columns: z.array(z.object({ id: z.string(), label: z.string() })),
							rows: z.array(siteDataRecordSchema),
						})
						.parse(JSON.parse(document.source));
					const databaseSchema = source.columns.map((column) => ({
						...column,
						name: column.label.toLowerCase().replaceAll(" ", "_"),
					}));
					const query = String(request.args.query);
					if (query.startsWith("SELECT * FROM data LIMIT 0")) {
						return Response.json({
							result: {
								columns: [],
								rows: [],
								schema: databaseSchema,
								truncated: false,
							},
						});
					}
					if (query.startsWith("SELECT COUNT(*)")) {
						return Response.json({
							result: {
								columns: ["total"],
								rows: [[source.rows.length]],
								schema: databaseSchema,
								truncated: false,
							},
						});
					}
					const parameters = z
						.array(siteDataValueSchema)
						.parse(request.args.parameters);
					const matchingRows = source.rows.filter(
						(row) =>
							row.owner === parameters[0] &&
							row.collection === parameters[1] &&
							(parameters[2] === null || row.key === parameters[2])
					);
					return Response.json({
						result: {
							columns: ["key", "value"],
							rows: matchingRows.map((row) => [row.key, row.value]),
							schema: databaseSchema,
							truncated: false,
						},
					});
				}
				default:
					throw new Error(`unexpected host method: ${request.method}`);
			}
		},
		{ preconnect: fetch.preconnect }
	);
	const database = createSitesSpacesDatabase({
		corePort: 7980,
		token: "sites-token",
		fetchImpl,
	});
	const binding = await database.ensureForSite({
		id: "site-1",
		name: "Pricing",
	});
	expect(binding).toEqual({ spaceId: "space-1", databaseId: "database-1" });
	expect(calls.slice(0, 3).map((call) => call.method)).toEqual([
		"spaces.ensureSpace",
		"spaces.listDatabases",
		"spaces.getDatabase",
	]);
	expect(document.revision).toBe(1);

	await database.saveRecord(binding, {
		owner: "visitor-1",
		collection: "notes",
		key: "first",
		value: JSON.stringify({ text: "stored in Ryu Spaces" }),
	});
	const editedGrid = z
		.object({
			columns: z.array(
				z.object({
					cell: siteDataValueSchema,
					id: z.string(),
					label: z.string(),
				})
			),
			rows: z.array(siteDataRecordSchema),
		})
		.parse(JSON.parse(document.source));
	editedGrid.columns.push({
		cell: { variant: "short-text" },
		id: "segment",
		label: "Segment",
	});
	const editedVisitorRow = editedGrid.rows.find(
		(row) => row.owner === "visitor-1"
	);
	expect(editedVisitorRow).toBeDefined();
	if (!editedVisitorRow) {
		throw new Error("expected the saved visitor row to exist");
	}
	editedVisitorRow.segment = "enterprise";
	document = {
		...document,
		source: JSON.stringify(editedGrid),
		revision: document.revision + 1,
	};
	await database.saveRecord(binding, {
		owner: "visitor-1",
		collection: "notes",
		key: "first",
		value: JSON.stringify({ text: "updated in Ryu Spaces" }),
	});
	const savedGrid = z
		.object({ rows: z.array(siteDataRecordSchema) })
		.parse(JSON.parse(document.source));
	expect(savedGrid.rows.find((row) => row.owner === "visitor-1")?.segment).toBe(
		"enterprise"
	);
	await database.saveRecord(binding, {
		owner: "visitor-2",
		collection: "notes",
		key: "first",
		value: JSON.stringify({ text: "private to visitor two" }),
	});
	expect(await database.records(binding, "visitor-1", "notes", null)).toEqual([
		{ key: "first", value: { text: "updated in Ryu Spaces" } },
	]);
	expect(await database.records(binding, "visitor-2", "notes", null)).toEqual([
		{ key: "first", value: { text: "private to visitor two" } },
	]);
	expect(await database.count(binding)).toBe(2);
	expect(
		await database.deleteRecord(binding, "visitor-1", "notes", "first")
	).toBe(true);
	expect(await database.records(binding, "visitor-1", "notes", null)).toEqual(
		[]
	);
	expect(await database.count(binding)).toBe(1);
});

test("one visitor's records cannot use up the Site database", async () => {
	let document = {
		id: "database-1",
		space_id: "space-1",
		title: "Site data",
		source: JSON.stringify({
			columns: [
				{ id: "owner", label: "Owner", cell: { variant: "short-text" } },
				{
					id: "collection",
					label: "Collection",
					cell: { variant: "short-text" },
				},
				{ id: "key", label: "Key", cell: { variant: "short-text" } },
				{ id: "value", label: "Value", cell: { variant: "long-text" } },
			],
			rows: [],
		}),
		revision: 0,
		kind: "database" as const,
	};
	const fetchImpl = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			const request = z
				.object({ args: siteDataRecordSchema, method: z.string() })
				.parse(JSON.parse(String(init?.body)));
			if (request.method === "spaces.getDatabase") {
				return Response.json({ result: document });
			}
			if (request.method === "spaces.updateDatabase") {
				document = {
					...document,
					source: String(request.args.source),
					revision: document.revision + 1,
				};
				return Response.json({ result: { revision: document.revision } });
			}
			throw new Error(`unexpected host method: ${request.method}`);
		},
		{ preconnect: fetch.preconnect }
	);
	const database = createSitesSpacesDatabase({
		corePort: 7980,
		token: "sites-token",
		fetchImpl,
	});
	const binding = { spaceId: "space-1", databaseId: "database-1" };
	const save = (owner: string, key: string, text: string) =>
		database.saveRecord(binding, {
			owner,
			collection: "notes",
			key,
			value: JSON.stringify({ text }),
		});
	const large = "x".repeat(50_000);
	await save("visitor-a", "first", large);
	await save("visitor-a", "second", large);
	await expect(save("visitor-a", "third", large)).rejects.toThrow(
		"your saved record limit"
	);
	await save("visitor-a", "second", "smaller now");
	await save("visitor-b", "first", large);
	const rows = z
		.object({ rows: z.array(siteDataRecordSchema) })
		.parse(JSON.parse(document.source)).rows;
	expect(rows.map((row) => `${row.owner}/${row.key}`)).toEqual([
		"visitor-a/first",
		"visitor-a/second",
		"visitor-b/first",
	]);
	const usage = await database.ownerUsage(binding);
	expect(usage.map(({ owner, records }) => ({ owner, records }))).toEqual([
		{ owner: "visitor-a", records: 2 },
		{ owner: "visitor-b", records: 1 },
	]);
	expect(usage.every((entry) => entry.bytes > 0)).toBe(true);
	// Purging one visitor frees that visitor's share without touching others.
	expect(await database.deleteOwnerRecords(binding, "visitor-a")).toBe(2);
	expect(await database.deleteOwnerRecords(binding, "visitor-a")).toBe(0);
	await save("visitor-a", "third", large);
	expect(
		(await database.ownerUsage(binding)).map(({ owner, records }) => ({
			owner,
			records,
		}))
	).toEqual([
		{ owner: "visitor-b", records: 1 },
		{ owner: "visitor-a", records: 1 },
	]);
});
