import { z } from "zod";

/** Values crossing Sites' JSON storage and generic host transport. Undefined is
 * retained until the existing JSON serializer omits an optional object field. */
export type SiteDataValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| SiteDataValue[]
	| SiteDataRecord;
export interface SiteDataRecord {
	[key: string]: SiteDataValue;
}
const scalar = z.union([
	z.string(),
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
	z.boolean(),
	z.null(),
	z.undefined(),
]);
const object = z.object({}).loose();
function isSiteObject(cause: unknown): cause is z.output<typeof object> {
	return object.safeParse(cause).success;
}
export const siteDataValueSchema: z.ZodType<SiteDataValue> =
	z.custom<SiteDataValue>((cause) => {
		if (scalar.safeParse(cause).success) {
			return true;
		}
		if (Array.isArray(cause)) {
			return cause.every(
				(entry) => siteDataValueSchema.safeParse(entry).success
			);
		}
		if (!isSiteObject(cause)) {
			return false;
		}
		return Object.values(cause).every(
			(entry) => siteDataValueSchema.safeParse(entry).success
		);
	});
export const siteDataRecordSchema: z.ZodType<SiteDataRecord> =
	z.custom<SiteDataRecord>(
		(cause) =>
			object.safeParse(cause).success &&
			siteDataValueSchema.safeParse(cause).success
	);
