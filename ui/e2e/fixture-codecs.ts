import { z } from "zod";
import {
	type SiteDataValue,
	siteDataValueSchema,
} from "../../sidecar/src/data-values.ts";
import { sitesCallsSchema } from "./fixture-records.ts";

interface SitesFixtureDecoders {
	calls(cause: SiteDataValue): z.output<typeof sitesCallsSchema>;
	message(cause: SiteDataValue): string | undefined;
	value(cause: SiteDataValue): SiteDataValue;
}
declare global {
	interface Window {
		__sitesFixtureDecoders: SitesFixtureDecoders;
		__sitesModelCalls?: { prompt: string; system: string }[];
		__sqlUnknown?: string[];
	}
}
window.__sitesFixtureDecoders = {
	value: (cause) => siteDataValueSchema.parse(cause),
	calls: (cause) => sitesCallsSchema.parse(cause),
	message: (cause) => {
		const parsed = z
			.object({
				error: z.object({ message: z.string().optional() }).optional(),
			})
			.safeParse(cause);
		return parsed.success ? parsed.data.error?.message : undefined;
	},
};
