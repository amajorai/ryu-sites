export interface RyuBridge {
	context?: { view?: string } | null;
}

declare global {
	interface Window {
		ryu?: RyuBridge;
	}
}
