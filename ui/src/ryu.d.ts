import type { RyuAppBridge } from "@ryu/app-host/app-bridge";
import type { SiteDataValue } from "../../sidecar/src/data-values.ts";
export interface RyuBridge extends RyuAppBridge {
	app?: {
		request(input: {
			path: string;
			method?: "GET" | "POST" | "PUT" | "DELETE";
			body?: SiteDataValue;
		}): Promise<SiteDataValue>;
	};
	context?: { view?: string } | null;
}

declare global {
	interface Window {
		ryu?: RyuBridge;
	}
}
