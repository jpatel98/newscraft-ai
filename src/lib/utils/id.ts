import { randomBytes } from 'node:crypto';

// Sortable IDs: 8-byte ms timestamp + 8-byte random, base32-ish.
// Not ULID-spec, but gives lexicographically increasing ids without a dep.
export function newId(): string {
	const ms = Date.now();
	const rand = randomBytes(8).toString('hex');
	return ms.toString(36).padStart(9, '0') + rand;
}
