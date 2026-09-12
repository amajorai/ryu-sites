import type { RyuAppBridge } from "@ryu/app-host/app-bridge";
export interface RyuBridge extends RyuAppBridge {
	app?: {
		request(input: {
			path: string;
			method?: "GET" | "POST" | "PUT" | "DELETE";
			body?: unknown;
		}): Promise<unknown>;
	};
	context?: { view?: string } | null;
}

declare global {
	interface Window {
		ryu?: RyuBridge;
	}
}
