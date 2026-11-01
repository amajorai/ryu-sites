/** Requests one visitor address may make to one Site per minute. */
export const VISITOR_RATE_LIMIT = 120;
/** Requests one Site accepts per minute across every visitor address. */
export const SITE_RATE_LIMIT = 6000;

/** Length of one rate-limit window, in seconds. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** The budget a refused request ran out of. */
export type RateLimitPolicyName = "visitor" | "site";

export type RateLimitDecision =
	| { allowed: true }
	| {
			allowed: false;
			limit: number;
			policy: RateLimitPolicyName;
			/** Whole seconds until the current window ends (at least 1). */
			retryAfter: number;
	  };

interface SiteBudget {
	accepted: number;
	minute: number;
	visitors: Map<string, number>;
}

/**
 * Per-Site, per-minute visitor request budgets.
 *
 * Each Site keeps its own table, and an address enters it only when one of its
 * requests is accepted. A table therefore never holds more addresses than the
 * Site's budget, and no shared table exists that traffic to one Site could fill
 * to refuse the visitors of another.
 */
export function createVisitorRateLimiter(
	options: {
		now?: () => number;
		siteLimit?: number;
		visitorLimit?: number;
	} = {}
) {
	const visitorLimit = options.visitorLimit ?? VISITOR_RATE_LIMIT;
	const siteLimit = options.siteLimit ?? SITE_RATE_LIMIT;
	const now = options.now ?? Date.now;
	const budgets = new Map<string, SiteBudget>();
	const budgetFor = (siteId: string, minute: number): SiteBudget => {
		const current = budgets.get(siteId);
		if (current?.minute === minute) {
			return current;
		}
		for (const [id, budget] of budgets) {
			if (budget.minute !== minute) {
				budgets.delete(id);
			}
		}
		const fresh: SiteBudget = { accepted: 0, minute, visitors: new Map() };
		budgets.set(siteId, fresh);
		return fresh;
	};
	const check = (siteId: string, visitor: string): RateLimitDecision => {
		const at = now();
		const minute = Math.floor(at / 60_000);
		const budget = budgetFor(siteId, minute);
		const used = budget.visitors.get(visitor) ?? 0;
		// An address over its own budget is refused before it can spend the
		// Site-wide budget that every other visitor shares.
		const refused: RateLimitPolicyName | null =
			used >= visitorLimit
				? "visitor"
				: budget.accepted >= siteLimit
					? "site"
					: null;
		if (refused) {
			return {
				allowed: false,
				policy: refused,
				limit: refused === "visitor" ? visitorLimit : siteLimit,
				retryAfter: Math.max(1, Math.ceil(((minute + 1) * 60_000 - at) / 1000)),
			};
		}
		budget.visitors.set(visitor, used + 1);
		budget.accepted += 1;
		return { allowed: true };
	};
	return {
		/** Accepts and counts one request, or returns false when over budget. */
		allow(siteId: string, visitor: string): boolean {
			return check(siteId, visitor).allowed;
		},
		/** Like `allow`, and says which budget a refusal ran out of and for how long. */
		check,
		policies: { visitor: visitorLimit, site: siteLimit } as const,
	};
}

/** Structured Field String serialization (RFC 9651 §4.1.6). */
function sfString(value: string): string {
	return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The response fields for a refused visitor request, in the IETF RateLimit
 * header format (draft-ietf-httpapi-ratelimit-headers, as the control-plane
 * API host sends them): both per-minute policies, the exhausted one with
 * nothing remaining, and `Retry-After` until the window resets.
 */
export function rateLimitHeaders(
	decision: Extract<RateLimitDecision, { allowed: false }>,
	policies: { site: number; visitor: number }
): Record<string, string> {
	return {
		"retry-after": String(decision.retryAfter),
		ratelimit: `${sfString(decision.policy)};r=0;t=${decision.retryAfter}`,
		"ratelimit-policy": [
			`${sfString("visitor")};q=${policies.visitor};w=${RATE_LIMIT_WINDOW_SECONDS}`,
			`${sfString("site")};q=${policies.site};w=${RATE_LIMIT_WINDOW_SECONDS}`,
		].join(", "),
	};
}
