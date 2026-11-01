import { expect, test } from "bun:test";
import { createVisitorRateLimiter } from "./rate-limit.ts";

test("an address over its own budget never spends the Site-wide budget", () => {
	const limiter = createVisitorRateLimiter({
		now: () => 0,
		siteLimit: 5,
		visitorLimit: 2,
	});
	expect(limiter.allow("site-a", "flooder")).toBe(true);
	expect(limiter.allow("site-a", "flooder")).toBe(true);
	for (let index = 0; index < 50; index += 1) {
		expect(limiter.allow("site-a", "flooder")).toBe(false);
	}
	expect(limiter.allow("site-a", "visitor-1")).toBe(true);
	expect(limiter.allow("site-a", "visitor-1")).toBe(true);
	expect(limiter.allow("site-a", "visitor-2")).toBe(true);
	expect(limiter.allow("site-a", "visitor-3")).toBe(false);
});

test("many addresses exhausting one Site never refuse visitors of another Site", () => {
	const limiter = createVisitorRateLimiter({
		now: () => 0,
		siteLimit: 100,
		visitorLimit: 2,
	});
	// More distinct addresses than any shared table could hold in one minute.
	for (let index = 0; index < 20_000; index += 1) {
		limiter.allow("site-a", `2001:db8::${index.toString(16)}`);
	}
	expect(limiter.allow("site-a", "203.0.113.9")).toBe(false);
	expect(limiter.allow("site-b", "203.0.113.9")).toBe(true);
	expect(limiter.allow("site-b", "198.51.100.4")).toBe(true);
});

test("budgets start over each minute", () => {
	let clock = 0;
	const limiter = createVisitorRateLimiter({
		now: () => clock,
		siteLimit: 10,
		visitorLimit: 1,
	});
	expect(limiter.allow("site-a", "visitor")).toBe(true);
	expect(limiter.allow("site-a", "visitor")).toBe(false);
	clock = 60_000;
	expect(limiter.allow("site-a", "visitor")).toBe(true);
});
