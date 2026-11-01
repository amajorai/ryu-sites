import { createHmac, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";

/** Size of the per-install key that names visitors in daily usage counters. */
export const VISITOR_QUOTA_KEY_BYTES = 32;
/** File beside `sites.sqlite` that holds the key. */
export const VISITOR_QUOTA_KEY_FILE = "visitor-quota.key";

const errorCode = (error: unknown) =>
	error instanceof Error && "code" in error ? error.code : undefined;

function readKey(path: string): Buffer | null {
	let size: number;
	try {
		size = statSync(path).size;
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return null;
		}
		throw error;
	}
	if (size !== VISITOR_QUOTA_KEY_BYTES) {
		// Rotating it silently would hand every visitor a fresh daily answer
		// share; an operator removes the file to accept that.
		throw new Error(
			`Sites visitor quota key ${path} is not ${VISITOR_QUOTA_KEY_BYTES} bytes; startup refused`
		);
	}
	const key = readFileSync(path);
	if (key.length !== VISITOR_QUOTA_KEY_BYTES) {
		throw new Error(
			`Sites visitor quota key ${path} changed while it was read; startup refused`
		);
	}
	chmodSync(path, 0o600);
	return key;
}

/**
 * Loads the per-install key, creating it once. A new key is written and
 * synced under a private temporary name, then hard-linked into place: the
 * link never replaces an existing key and never exposes a partial one, so
 * processes starting together all read the same key.
 */
export function loadVisitorQuotaKey(path: string): Buffer {
	const existing = readKey(path);
	if (existing) {
		return existing;
	}
	const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeSync(descriptor, randomBytes(VISITOR_QUOTA_KEY_BYTES));
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	try {
		linkSync(temporary, path);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") {
			throw error;
		}
	} finally {
		rmSync(temporary, { force: true });
	}
	const created = readKey(path);
	if (!created) {
		throw new Error(`Sites visitor quota key ${path} could not be created`);
	}
	return created;
}

/**
 * Names one visitor's counter for one Site and UTC day. The same visitor keeps
 * one name all day, across restarts, while names from different days or Sites
 * cannot be linked, and the counter never holds a raw account ID or address.
 */
export function visitorQuotaKey(
	key: Uint8Array,
	siteId: string,
	day: string,
	visitor: string
): string {
	return createHmac("sha256", key)
		.update(`quota:${siteId}:${day}:${visitor}`)
		.digest("hex")
		.slice(0, 32);
}
