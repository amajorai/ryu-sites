import { createHash } from "node:crypto";
import type { z } from "zod";
import {
	OWNER_CONNECTION_PREFIX,
	type OwnerConnection,
	type ownerConnectionInput,
	type RuntimeSite,
} from "./contracts.ts";
import type { ApprovedConnection } from "./extensions.ts";
import { SiteError } from "./store.ts";

/**
 * Operator policy for owner-managed bindings, read from `runtime.json`. The
 * operator always wins: a disabled switch or an allowlist hides bindings that
 * were saved before the policy changed.
 */
export interface OwnerConnectionPolicy {
	/** Exact Core agent IDs or `prefix*` patterns owner bindings may run as. */
	agents: readonly string[];
	enabled: boolean;
	/**
	 * Tools the operator vouches are read-only. Only these may be bound with
	 * read access; any other owner binding is treated as read and write.
	 */
	readOnlyTools: readonly string[];
	/** Exact tool IDs or `prefix*` patterns; null allows every tool. */
	tools: readonly string[] | null;
}
export const DEFAULT_OWNER_CONNECTION_POLICY: OwnerConnectionPolicy = {
	agents: ["ryu"],
	enabled: true,
	readOnlyTools: [],
	tools: null,
};
/** What an unreadable operator policy means: owner bindings are off. */
export const CLOSED_OWNER_CONNECTION_POLICY: OwnerConnectionPolicy = {
	agents: [],
	enabled: false,
	readOnlyTools: [],
	tools: [],
};

/**
 * Reads the operator policy and fails closed: a malformed or mid-edit
 * runtime.json turns owner bindings off instead of breaking the request.
 */
export function readOwnerConnectionPolicy(
	read: (() => OwnerConnectionPolicy) | undefined
): OwnerConnectionPolicy {
	if (!read) {
		return DEFAULT_OWNER_CONNECTION_POLICY;
	}
	try {
		return read();
	} catch {
		return CLOSED_OWNER_CONNECTION_POLICY;
	}
}

/** One connection a visitor can review and run, with where it came from. */
export interface SiteConnection extends ApprovedConnection {
	/** Who saved an owner binding; operator bindings have none. */
	addedBy?: "owner" | "editor";
	description: string;
	revision: string;
	source: "operator" | "owner";
}

const matchesPattern = (patterns: readonly string[], value: string) =>
	patterns.some((pattern) =>
		pattern.endsWith("*")
			? value.startsWith(pattern.slice(0, -1))
			: value === pattern
	);

export function ownerConnectionToolAllowed(
	policy: OwnerConnectionPolicy,
	toolId: string
): boolean {
	if (!policy.enabled) {
		return false;
	}
	return policy.tools ? matchesPattern(policy.tools, toolId) : true;
}

export function ownerConnectionAgentAllowed(
	policy: OwnerConnectionPolicy,
	agentId: string
): boolean {
	return policy.enabled && matchesPattern(policy.agents, agentId);
}

/** Whether the operator lets a saved binding reach visitors at all. */
export function ownerConnectionAllowed(
	policy: OwnerConnectionPolicy,
	connection: Pick<OwnerConnection, "agentId" | "toolId">
): boolean {
	return (
		ownerConnectionToolAllowed(policy, connection.toolId) &&
		ownerConnectionAgentAllowed(policy, connection.agentId)
	);
}

/**
 * The access a binding actually gets. An owner's read-only flag is only a
 * request; it holds when the operator vouches the tool is read-only.
 */
export function ownerConnectionReadOnly(
	policy: OwnerConnectionPolicy,
	connection: Pick<OwnerConnection, "readOnly" | "toolId">
): boolean {
	return (
		connection.readOnly &&
		matchesPattern(policy.readOnlyTools, connection.toolId)
	);
}

/** The visitor-facing ID of an owner binding. */
export const ownerConnectionPublicId = (id: string) =>
	`${OWNER_CONNECTION_PREFIX}${id}`;

/** Operator bindings keep their established revision digest. */
export function operatorConnectionRevision(connection: ApprovedConnection) {
	return createHash("sha256").update(JSON.stringify(connection)).digest("hex");
}

/**
 * Covers everything a visitor approved: tool, agent, access, wording, and the
 * owner's revision counter, so any change asks every visitor again.
 */
export function ownerConnectionRevision(
	connection: OwnerConnection,
	effectiveReadOnly = connection.readOnly
) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				source: "owner",
				id: connection.id,
				toolId: connection.toolId,
				agentId: connection.agentId,
				readOnly: effectiveReadOnly,
				label: connection.label,
				description: connection.description,
				revision: connection.revision,
			})
		)
		.digest("hex");
}

/**
 * The connections visitors of a Site may use: operator bindings the deployed
 * version selected, then owner bindings the operator policy still allows.
 * An owner binding never shadows an operator binding with the same ID.
 */
export function resolveSiteConnections(input: {
	site: RuntimeSite;
	operator: readonly ApprovedConnection[];
	operatorSelected: readonly string[];
	policy: OwnerConnectionPolicy;
}): SiteConnection[] {
	const operator: SiteConnection[] = input.operator
		.filter((connection) => input.operatorSelected.includes(connection.id))
		.map((connection) => ({
			...connection,
			description: "",
			revision: operatorConnectionRevision(connection),
			source: "operator",
		}));
	const taken = new Set(input.operator.map((connection) => connection.id));
	const owner: SiteConnection[] = (input.site.connections ?? [])
		.filter(
			(connection) =>
				ownerConnectionAllowed(input.policy, connection) &&
				!taken.has(ownerConnectionPublicId(connection.id))
		)
		.map((connection) => {
			const readOnly = ownerConnectionReadOnly(input.policy, connection);
			return {
				id: ownerConnectionPublicId(connection.id),
				label: connection.label,
				description: connection.description,
				toolId: connection.toolId,
				agentId: connection.agentId,
				readOnly,
				revision: ownerConnectionRevision(connection, readOnly),
				source: "owner",
				addedBy:
					connection.updatedBy === input.site.ownerId ? "owner" : "editor",
			};
		});
	return [...operator, ...owner];
}

export interface OwnerConnectionChanges {
	added: string[];
	changed: string[];
	next: OwnerConnection[];
	removed: string[];
}

/**
 * Applies a full replacement list. Unchanged bindings keep their revision;
 * any material change, or an explicit reconsent request, bumps it.
 */
export function applyOwnerConnections(input: {
	current: readonly OwnerConnection[];
	requested: readonly z.output<typeof ownerConnectionInput>[];
	policy: OwnerConnectionPolicy;
	actor: string;
	now: string;
}): OwnerConnectionChanges {
	const previous = new Map(input.current.map((entry) => [entry.id, entry]));
	const added: string[] = [];
	const changed: string[] = [];
	const next = input.requested.map((entry): OwnerConnection => {
		const before = previous.get(entry.id);
		const material =
			!before ||
			before.toolId !== entry.toolId ||
			before.agentId !== entry.agentId ||
			before.readOnly !== entry.readOnly ||
			before.label !== entry.label ||
			before.description !== entry.description;
		// Unchanged bindings pass through untouched so one can be edited or
		// removed while another is blocked; resolveSiteConnections still hides
		// whatever the operator policy no longer allows.
		if (before && !material && !entry.reconsent) {
			return before;
		}
		assertOwnerConnectionAllowed(input.policy, entry);
		(before ? changed : added).push(entry.id);
		return {
			id: entry.id,
			label: entry.label,
			description: entry.description,
			toolId: entry.toolId,
			agentId: entry.agentId,
			readOnly: entry.readOnly,
			revision: (before?.revision ?? 0) + 1,
			updatedAt: input.now,
			updatedBy: input.actor,
		};
	});
	const kept = new Set(next.map((entry) => entry.id));
	const removed = input.current
		.filter((entry) => !kept.has(entry.id))
		.map((entry) => entry.id);
	return { added, changed, next, removed };
}

function assertOwnerConnectionAllowed(
	policy: OwnerConnectionPolicy,
	entry: z.output<typeof ownerConnectionInput>
) {
	if (!policy.enabled) {
		throw new SiteError(
			"forbidden",
			"Your operator does not allow Site owners to add connections",
			403
		);
	}
	if (!ownerConnectionToolAllowed(policy, entry.toolId)) {
		throw new SiteError(
			"forbidden",
			`Your operator has not approved the tool "${entry.toolId}" for Site connections`,
			403
		);
	}
	if (!ownerConnectionAgentAllowed(policy, entry.agentId)) {
		throw new SiteError(
			"forbidden",
			`Your operator has not approved the agent "${entry.agentId}" for Site connections`,
			403
		);
	}
	if (entry.readOnly && !ownerConnectionReadOnly(policy, entry)) {
		throw new SiteError(
			"forbidden",
			`Your operator has not confirmed that "${entry.toolId}" is read-only. Bind it with read and write access.`,
			403
		);
	}
}
