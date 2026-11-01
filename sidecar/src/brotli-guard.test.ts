import { afterAll, describe, expect, test } from "bun:test";
import { createSitesServer } from "./server.ts";
import { SitesStore } from "./store.ts";

const TOKEN = "brotli-guard-test-token";
const cleanup: (() => void)[] = [];
afterAll(() => {
	for (const close of cleanup.splice(0)) {
		close();
	}
});

function start() {
	const store = new SitesStore(":memory:");
	const server = createSitesServer({
		store,
		token: TOKEN,
		port: 0,
		visitorPort: 0,
		publicEnabled: true,
		services: {},
	});
	cleanup.push(() => {
		server.stop();
		store.close();
	});
	return server;
}

describe("Brotli request guard", () => {
	test("both listeners refuse a Brotli-encoded request body with 415", async () => {
		const server = start();
		for (const [port, path] of [
			[server.admin.port, "/health"],
			[server.visitor.port, "/_ryu/anything"],
		] as const) {
			for (const encoding of ["br", "gzip, BR"]) {
				const response = await fetch(`http://127.0.0.1:${port}${path}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${TOKEN}`,
						"content-type": "application/json",
						"content-encoding": encoding,
					},
					body: "{}",
				});
				expect(response.status).toBe(415);
				const payload = (await response.json()) as { error: { code: string } };
				expect(payload.error.code).toBe("unsupported_encoding");
			}
		}
	});

	test("other request encodings still reach the handlers", async () => {
		const server = start();
		const response = await fetch(
			`http://127.0.0.1:${server.admin.port}/health`
		);
		expect(response.status).toBe(200);
	});
});
