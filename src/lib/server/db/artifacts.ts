import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { db } from './index';
import {
	artifactAssets,
	artifactFamilies,
	artifactRevisions,
	artifactUploadGrants,
	artifactVerifications,
	conversations,
	hermesRuns,
	hermesRunArtifactRefs,
	messages
} from './schema';
import { newId } from '$lib/utils/id';
import {
	ARTIFACT_MAX_ASSET_BYTES,
	ARTIFACT_MAX_PREVIEW_BYTES,
	ArtifactValidationError,
	parseArtifactSpec,
	serializeArtifactSpec,
	type ArtifactAssetRole,
	type ArtifactDetail,
	type ArtifactKind,
	type ArtifactSpec,
	type ArtifactStatus,
	type ArtifactSummary
} from '$lib/server/artifacts/contracts';
import type { VerifiedArtifactObject } from '$lib/server/artifacts/storage';

export class ArtifactRepositoryError extends Error {
	readonly code: 'not_found' | 'conflict' | 'stale' | 'invalid_input';
	constructor(code: ArtifactRepositoryError['code'], message: string) {
		super(message);
		this.name = 'ArtifactRepositoryError';
		this.code = code;
	}
}

export interface ArtifactFamilyRecord {
	id: string;
	accountId: string;
	orgId: string | null;
	conversationId: string;
	sourceMessageId: string;
	kind: ArtifactKind;
	title: string;
	latestRevisionId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactRevisionRecord {
	id: string;
	familyId: string;
	revision: number;
	status: ArtifactStatus;
	specJson: string;
	specSha256: string;
	baseRevisionId: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	createdAt: number;
	updatedAt: number;
	readyAt: number | null;
}

export interface ArtifactGrantRecord {
	id: string;
	revisionId: string;
	runId: string | null;
	role: ArtifactAssetRole;
	producerKey: string;
	tokenHash: string;
	stagingKey: string;
	finalKey: string;
	uploadedObjectVersion: string | null;
	allowedMime: string;
	maxBytes: number;
	exactBytes: number | null;
	expectedSha256: string | null;
	expiresAt: number;
	state: 'issued' | 'uploaded' | 'consumed' | 'expired' | 'revoked';
	createdAt: number;
	uploadedAt: number | null;
	consumedAt: number | null;
}

const MAX_TITLE = 200;
const MAX_GRANT_TTL_MS = 10 * 60 * 1000;
const ARTIFACT_UPLOAD_MIME_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'text/csv',
	'text/markdown',
	'application/json'
]);

function safeText(value: unknown, label: string, max: number): string {
	if (typeof value !== 'string') throw new ArtifactRepositoryError('invalid_input', `${label} is required`);
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > max) throw new ArtifactRepositoryError('invalid_input', `${label} is invalid`);
	return trimmed;
}

function safeKeySegment(value: unknown, label: string, max = 256): string {
	const result = safeText(value, label, max);
	if (
		result === '.' ||
		result === '..' ||
		result.includes('/') ||
		result.includes('\\') ||
		/[\u0000-\u001f\u007f]/u.test(result)
	) {
		throw new ArtifactRepositoryError('invalid_input', `${label} is invalid`);
	}
	return result;
}

function parseRows(value: unknown): ArtifactSummary[] {
	return Array.isArray(value) ? value as ArtifactSummary[] : [];
}

function grantFromRow(row: any): ArtifactGrantRecord {
	return {
		id: row.id,
		revisionId: row.revision_id ?? row.revisionId,
		runId: row.run_id ?? row.runId ?? null,
		role: row.role,
		producerKey: row.producer_key ?? row.producerKey,
		tokenHash: row.token_hash ?? row.tokenHash,
		stagingKey: row.staging_key ?? row.stagingKey,
		finalKey: row.final_key ?? row.finalKey,
		uploadedObjectVersion: row.uploaded_object_version ?? row.uploadedObjectVersion ?? null,
		allowedMime: row.allowed_mime ?? row.allowedMime,
		maxBytes: Number(row.max_bytes ?? row.maxBytes),
		exactBytes: row.exact_bytes == null && row.exactBytes == null ? null : Number(row.exact_bytes ?? row.exactBytes),
		expectedSha256: row.expected_sha256 ?? row.expectedSha256 ?? null,
		expiresAt: Number(row.expires_at ?? row.expiresAt),
		state: row.state,
		createdAt: Number(row.created_at ?? row.createdAt),
		uploadedAt: row.uploaded_at ?? row.uploadedAt ?? null,
		consumedAt: row.consumed_at ?? row.consumedAt ?? null
	};
}

function summaryFromRow(row: any): ArtifactSummary {
	return {
		id: row.id,
		revisionId: row.revision_id,
		revision: Number(row.revision),
		kind: row.kind,
		title: row.title,
		status: row.status,
		sourceMessageId: row.source_message_id,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		...(row.fixture === true ? { fixture: true } : {}),
		preview: row.preview_asset_id
			? {
				assetId: row.preview_asset_id,
				mimeType: row.preview_mime_type,
				sizeBytes: Number(row.preview_size_bytes),
				width: row.preview_width === null ? null : Number(row.preview_width),
				height: row.preview_height === null ? null : Number(row.preview_height)
			}
			: null,
		error: row.error_code
			? { code: row.error_code, message: row.error_message || 'The artifact could not be published.' }
			: null
	};
}

const HERMES_RUN_ACTIVE_STATES = new Set(['queued', 'researching', 'writing', 'reconnecting']);

/** Lock and validate the run lease before an artifact mutation.  Artifact
 * publication is a capability of the currently leased run, not of a bearer
 * callback token alone; this prevents cancellation and lease turnover races
 * from committing a late revision or upload grant. */
async function lockArtifactRunLease(
	tx: any,
	input: { accountId: string; runId: string; tenantKey?: string; leaseOwner: string; leaseToken: string },
	now: number
): Promise<any> {
	const [run] = await tx.execute(sql`
		SELECT id, account_id, tenant_key, conversation_id, assistant_message_id,
			state, lease_owner, lease_token, lease_expires_at
		FROM hermes_runs
		WHERE id = ${input.runId} AND account_id = ${input.accountId}
		FOR UPDATE
	`);
	if (!run) throw new ArtifactRepositoryError('not_found', 'run not found');
	if (input.tenantKey !== undefined && run.tenant_key !== input.tenantKey) {
		throw new ArtifactRepositoryError('conflict', 'run tenant binding does not match');
	}
	if (
		!HERMES_RUN_ACTIVE_STATES.has(String(run.state)) ||
		run.lease_owner !== input.leaseOwner ||
		run.lease_token !== input.leaseToken ||
		run.lease_expires_at === null ||
		Number(run.lease_expires_at) <= now
	) {
		throw new ArtifactRepositoryError('stale', 'run lease is stale or terminal');
	}
	return run;
}

async function ownedRevision(tx: any, accountId: string, revisionId: string) {
	const [row] = await tx.execute(sql`
		SELECT
			r.id, r.family_id, r.revision, r.status, r.spec_json, r.spec_sha256,
			r.base_revision_id, r.error_code, r.error_message, r.created_at, r.updated_at, r.ready_at,
			f.account_id, f.org_id, f.conversation_id, f.source_message_id, f.kind, f.title, f.latest_revision_id, f.created_at AS family_created_at, f.updated_at AS family_updated_at
		FROM artifact_revisions r
		JOIN artifact_families f ON f.id = r.family_id
		WHERE r.id = ${revisionId} AND f.account_id = ${accountId}
		FOR UPDATE OF r, f
	`);
	if (!row) throw new ArtifactRepositoryError('not_found', 'artifact revision not found');
	return row;
}

export async function createArtifactRevision(input: {
	accountId: string;
	conversationId: string;
	sourceMessageId: string;
	kind: ArtifactKind;
	title: string;
	spec: unknown;
	familyId?: string;
	baseRevisionId?: string | null;
	now?: number;
}): Promise<{ family: ArtifactFamilyRecord; revision: ArtifactRevisionRecord }> {
	const accountId = safeText(input.accountId, 'accountId', 256);
	const conversationId = safeText(input.conversationId, 'conversationId', 256);
	const sourceMessageId = safeText(input.sourceMessageId, 'sourceMessageId', 256);
	const title = safeText(input.title, 'title', MAX_TITLE);
	const spec = parseArtifactSpec(input.spec);
	if (spec.kind !== input.kind) throw new ArtifactRepositoryError('invalid_input', 'artifact kind does not match spec');
	const serialized = serializeArtifactSpec(spec);
	const now = input.now ?? Date.now();
	return db.transaction(async (tx: any) => {
		const [owner] = await tx.execute(sql`
			SELECT c.id, c.org_id, m.id AS message_id
			FROM conversations c JOIN messages m ON m.conversation_id = c.id
			WHERE c.id = ${conversationId} AND c.account_id = ${accountId} AND m.id = ${sourceMessageId}
			FOR UPDATE OF c, m
		`);
		if (!owner) throw new ArtifactRepositoryError('not_found', 'conversation or source message not found');
		let familyId = input.familyId?.trim() || newId();
		let revisionNumber = 1;
		if (input.familyId) {
			const [family] = await tx.execute(sql`SELECT id FROM artifact_families WHERE id = ${familyId} AND account_id = ${accountId} FOR UPDATE`);
			if (!family) throw new ArtifactRepositoryError('not_found', 'artifact family not found');
			const [latest] = await tx.execute(sql`SELECT revision, id FROM artifact_revisions WHERE family_id = ${familyId} ORDER BY revision DESC LIMIT 1 FOR UPDATE`);
			revisionNumber = Number(latest?.revision || 0) + 1;
			if (input.baseRevisionId && latest?.id !== input.baseRevisionId) throw new ArtifactRepositoryError('conflict', 'artifact revision is stale');
		} else {
			await tx.insert(artifactFamilies).values({
				id: familyId,
				accountId,
				orgId: owner.org_id ?? null,
				conversationId,
				sourceMessageId,
				kind: input.kind,
				title,
				latestRevisionId: null,
				createdAt: now,
				updatedAt: now
			});
		}
		const revisionId = newId();
		await tx.insert(artifactRevisions).values({
			id: revisionId,
			familyId,
			revision: revisionNumber,
			status: 'draft',
			specJson: serialized.json,
			specSha256: serialized.sha256,
			baseRevisionId: input.baseRevisionId ?? null,
			errorCode: null,
			errorMessage: null,
			createdAt: now,
			updatedAt: now,
			readyAt: null
		});
		await tx.update(artifactFamilies).set({ latestRevisionId: revisionId, updatedAt: now }).where(eq(artifactFamilies.id, familyId));
		return {
			family: { id: familyId, accountId, orgId: owner.org_id ?? null, conversationId, sourceMessageId, kind: input.kind, title, latestRevisionId: revisionId, createdAt: now, updatedAt: now },
			revision: { id: revisionId, familyId, revision: revisionNumber, status: 'draft', specJson: serialized.json, specSha256: serialized.sha256, baseRevisionId: input.baseRevisionId ?? null, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, readyAt: null }
		};
	});
}

/** Create a revision from the active durable run.  The assistant message and
 * conversation are resolved from the locked run row; the model cannot choose
 * a source message or another conversation. Inline specs may be committed
 * ready in this transaction, while file-backed image revisions remain draft
 * until the server verifier finalizes their immutable object. */
export async function createArtifactRevisionForRun(input: {
	accountId: string;
	runId: string;
	tenantKey: string;
	leaseOwner: string;
	leaseToken: string;
	title?: string;
	spec: unknown;
	readyInline?: boolean;
	now?: number;
}): Promise<{ family: ArtifactFamilyRecord; revision: ArtifactRevisionRecord }> {
	const accountId = safeText(input.accountId, 'accountId', 256);
	const runId = safeText(input.runId, 'runId', 256);
	const tenantKey = safeText(input.tenantKey, 'tenantKey', 256);
	const leaseOwner = safeText(input.leaseOwner, 'leaseOwner', 256);
	const leaseToken = safeText(input.leaseToken, 'leaseToken', 256);
	const spec = parseArtifactSpec(input.spec);
	if (spec.fixture === true) {
		// Synthetic fixtures are reserved for the explicit local demo endpoint;
		// a real Hermes run must never be able to label model output as a demo.
		throw new ArtifactRepositoryError('invalid_input', 'synthetic fixture artifacts are not allowed for runtime publication');
	}
	const title = safeText(input.title || spec.title, 'title', MAX_TITLE);
	const now = input.now ?? Date.now();
	const ready = input.readyInline === true && spec.kind !== 'image';

	return db.transaction(async (tx: any) => {
		const run = await lockArtifactRunLease(
			tx,
			{ accountId, runId, tenantKey, leaseOwner, leaseToken },
			now
		);
		const [owner] = await tx.execute(sql`
			SELECT c.id, c.org_id, m.id AS message_id
			FROM conversations c
			JOIN messages m ON m.conversation_id = c.id
			WHERE c.id = ${run.conversation_id}
				AND c.account_id = ${accountId}
				AND m.id = ${run.assistant_message_id}
				AND m.role = 'assistant'
			FOR UPDATE OF c, m
		`);
		if (!owner) throw new ArtifactRepositoryError('not_found', 'run assistant message not found');
		const familyId = newId();
		const serialized = serializeArtifactSpec(spec);
		const revisionId = newId();
		const status = ready ? 'ready' : 'draft';
		await tx.insert(artifactFamilies).values({
			id: familyId,
			accountId,
			orgId: owner.org_id ?? null,
			conversationId: run.conversation_id,
			sourceMessageId: run.assistant_message_id,
			kind: spec.kind,
			title,
			latestRevisionId: revisionId,
			createdAt: now,
			updatedAt: now
		});
		await tx.insert(artifactRevisions).values({
			id: revisionId,
			familyId,
			revision: 1,
			status,
			specJson: serialized.json,
			specSha256: serialized.sha256,
			baseRevisionId: null,
			errorCode: null,
			errorMessage: null,
			createdAt: now,
			updatedAt: now,
			readyAt: ready ? now : null
		});
		return {
			family: {
				id: familyId,
				accountId,
				orgId: owner.org_id ?? null,
				conversationId: run.conversation_id,
				sourceMessageId: run.assistant_message_id,
				kind: spec.kind,
				title,
				latestRevisionId: revisionId,
				createdAt: now,
				updatedAt: now
			},
			revision: {
				id: revisionId,
				familyId,
				revision: 1,
				status,
				specJson: serialized.json,
				specSha256: serialized.sha256,
				baseRevisionId: null,
				errorCode: null,
				errorMessage: null,
				createdAt: now,
				updatedAt: now,
				readyAt: ready ? now : null
			}
		};
	});
}

export async function createArtifactUploadGrant(input: {
	accountId: string;
	revisionId: string;
	runId?: string | null;
	lease?: { tenantKey: string; leaseOwner: string; leaseToken: string };
	role: ArtifactAssetRole;
	producerKey: string;
	allowedMime: string;
	maxBytes?: number;
	exactBytes?: number | null;
	expectedSha256?: string | null;
	now?: number;
}): Promise<{ grant: ArtifactGrantRecord; token: string }> {
	const accountId = safeKeySegment(input.accountId, 'accountId');
	const revisionId = safeKeySegment(input.revisionId, 'revisionId');
	const producerKey = safeKeySegment(input.producerKey, 'producerKey');
	const allowedMime = safeText(input.allowedMime, 'allowedMime', 120).toLowerCase();
	if (!ARTIFACT_UPLOAD_MIME_TYPES.has(allowedMime)) {
		throw new ArtifactRepositoryError('invalid_input', 'allowedMime is unsupported');
	}
	if (!['source', 'preview', 'data'].includes(input.role)) {
		throw new ArtifactRepositoryError('invalid_input', 'role is invalid');
	}
	const requestedMax = input.maxBytes ?? ARTIFACT_MAX_ASSET_BYTES;
	if (typeof requestedMax !== 'number' || !Number.isSafeInteger(requestedMax) || requestedMax < 1) {
		throw new ArtifactRepositoryError('invalid_input', 'maxBytes is invalid');
	}
	const maxBytes = Math.min(requestedMax, input.role === 'preview' ? ARTIFACT_MAX_PREVIEW_BYTES : ARTIFACT_MAX_ASSET_BYTES);
	const exactBytes = input.exactBytes == null ? null : input.exactBytes;
	if (exactBytes !== null && (!Number.isSafeInteger(exactBytes) || exactBytes < 1 || exactBytes > maxBytes)) throw new ArtifactRepositoryError('invalid_input', 'exactBytes is invalid');
	let expectedSha256: string | null = null;
	if (input.expectedSha256 != null) {
		if (typeof input.expectedSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(input.expectedSha256.trim())) {
			throw new ArtifactRepositoryError('invalid_input', 'expectedSha256 is invalid');
		}
		expectedSha256 = input.expectedSha256.trim().toLowerCase();
	}
	const now = input.now ?? Date.now();
	const expiresAt = now + MAX_GRANT_TTL_MS;
	const token = randomBytes(32).toString('base64url');
	const tokenHash = createHash('sha256').update(token).digest('hex');
	const grantId = newId();
	const stagingKey = `staging/${accountId}/${revisionId}/${grantId}`;
	const finalKey = `artifacts/${accountId}/${revisionId}/${grantId}`;
	return db.transaction(async (tx: any) => {
		let run: any = null;
		if (input.runId) {
			if (!input.lease) throw new ArtifactRepositoryError('invalid_input', 'run lease is required');
			run = await lockArtifactRunLease(tx, {
				accountId,
				runId: safeKeySegment(input.runId, 'runId'),
				tenantKey: safeText(input.lease.tenantKey, 'tenantKey', 256),
				leaseOwner: safeText(input.lease.leaseOwner, 'leaseOwner', 256),
				leaseToken: safeText(input.lease.leaseToken, 'leaseToken', 256)
			}, now);
		}
		const revision = await ownedRevision(tx, accountId, revisionId);
		if (run && (run.conversation_id !== revision.conversation_id || run.assistant_message_id !== revision.source_message_id)) {
			throw new ArtifactRepositoryError('conflict', 'artifact revision is not bound to this run');
		}
		if (!['draft', 'publishing'].includes(revision.status)) throw new ArtifactRepositoryError('conflict', 'artifact revision is not publishable');
		// Lock the unique producer row before deciding whether to re-issue. Two
		// retries can otherwise both read the old generation and return tokens
		// that race to overwrite each other.
		const existing = await tx.select().from(artifactUploadGrants).where(and(eq(artifactUploadGrants.revisionId, revisionId), eq(artifactUploadGrants.role, input.role), eq(artifactUploadGrants.producerKey, producerKey))).limit(1).for('update');
		if (existing[0] && existing[0].state !== 'consumed') {
			// The token is intentionally stored only as a hash, so a retry cannot
			// recover the original bearer token. Re-issue the grant in place with
			// fresh random object keys and a fresh token; the old local endpoint
			// token immediately stops matching the database hash.
			await tx.update(artifactUploadGrants).set({
				runId: input.runId ?? existing[0].runId ?? null,
				tokenHash,
				stagingKey,
				finalKey,
				uploadedObjectVersion: null,
				allowedMime,
				maxBytes,
				exactBytes,
				expectedSha256,
				expiresAt,
				state: 'issued',
				uploadedAt: null,
				consumedAt: null
			}).where(eq(artifactUploadGrants.id, existing[0].id));
			const [refreshed] = await tx.select().from(artifactUploadGrants).where(eq(artifactUploadGrants.id, existing[0].id)).limit(1);
			return { grant: refreshed as ArtifactGrantRecord, token };
		}
		if (existing[0] && existing[0].state === 'consumed') {
			throw new ArtifactRepositoryError('conflict', 'artifact grant is already finalized');
		}
		await tx.update(artifactRevisions).set({ status: 'publishing', updatedAt: now }).where(eq(artifactRevisions.id, revisionId));
		const [inserted] = await tx.insert(artifactUploadGrants).values({
			id: grantId,
			revisionId,
			runId: input.runId ?? null,
			role: input.role,
			producerKey,
			tokenHash,
			stagingKey,
			finalKey,
			uploadedObjectVersion: null,
			allowedMime,
			maxBytes,
			exactBytes,
			expectedSha256,
			expiresAt,
			state: 'issued',
			createdAt: now,
			uploadedAt: null,
			consumedAt: null
		}).returning();
		return { grant: inserted as ArtifactGrantRecord, token };
	});
}

export async function getArtifactGrantByToken(grantId: string, token: string): Promise<(ArtifactGrantRecord & { accountId: string; conversationId: string; sourceMessageId: string }) | null> {
	const tokenHash = createHash('sha256').update(token).digest('hex');
	const rows = await db.execute(sql`
		SELECT g.*, f.account_id, f.conversation_id, f.source_message_id
		FROM artifact_upload_grants g JOIN artifact_revisions r ON r.id = g.revision_id JOIN artifact_families f ON f.id = r.family_id
		WHERE g.id = ${grantId} AND g.token_hash = ${tokenHash}
		LIMIT 1
	`);
	return rows[0] ? { ...grantFromRow(rows[0]), accountId: rows[0].account_id, conversationId: rows[0].conversation_id, sourceMessageId: rows[0].source_message_id } : null;
}

export async function markArtifactGrantUploaded(grantId: string, version: string, now = Date.now()): Promise<void> {
	await db.update(artifactUploadGrants).set({ state: 'uploaded', uploadedObjectVersion: version, uploadedAt: now }).where(and(eq(artifactUploadGrants.id, grantId), eq(artifactUploadGrants.state, 'issued')));
}

/** Mark an upload only if the bearer token and staging generation are still
 * current. A grant may be re-issued while an older PUT is in flight; the
 * stale upload must not attach its object version to the refreshed grant. */
export async function markArtifactGrantUploadedForToken(
	grantId: string,
	token: string,
	stagingKey: string,
	version: string,
	now = Date.now()
): Promise<boolean> {
	const tokenHash = createHash('sha256').update(token).digest('hex');
	const rows = await db.update(artifactUploadGrants)
		.set({ state: 'uploaded', uploadedObjectVersion: version, uploadedAt: now })
		.where(and(
			eq(artifactUploadGrants.id, grantId),
			eq(artifactUploadGrants.state, 'issued'),
			eq(artifactUploadGrants.tokenHash, tokenHash),
			eq(artifactUploadGrants.stagingKey, stagingKey),
			gt(artifactUploadGrants.expiresAt, now)
		))
		.returning({ id: artifactUploadGrants.id });
	return rows.length > 0;
}

export async function getArtifactGrant(accountId: string, grantId: string): Promise<ArtifactGrantRecord | null> {
	const rows = await db.execute(sql`
		SELECT g.* FROM artifact_upload_grants g
		JOIN artifact_revisions r ON r.id = g.revision_id JOIN artifact_families f ON f.id = r.family_id
		WHERE g.id = ${grantId} AND f.account_id = ${accountId} LIMIT 1
	`);
	return rows[0] ? grantFromRow(rows[0]) : null;
}

/** Return the durable summary produced by an already-consumed grant. A
 * run-bound grant still requires the current run lease, even on a retry after
 * finalization. The run is locked before the grant is read so cancellation or
 * lease turnover cannot race this authorization check. */
export async function getFinalizedArtifactForGrant(
	accountId: string,
	grantId: string,
	lease?: { runId: string; tenantKey: string; leaseOwner: string; leaseToken: string }
): Promise<ArtifactSummary | null> {
	const owner = safeText(accountId, 'accountId', 256);
	const id = safeText(grantId, 'grantId', 256);
	const now = Date.now();
	return db.transaction(async (tx: any) => {
		// Do not lock the grant before the run: all run-bound artifact mutations
		// use run -> grant ordering to avoid a finalization/cancellation deadlock.
		const [identity] = await tx.execute(sql`
			SELECT g.run_id, g.revision_id, g.state,
				f.conversation_id, f.source_message_id
			FROM artifact_upload_grants g
			JOIN artifact_revisions r ON r.id = g.revision_id
			JOIN artifact_families f ON f.id = r.family_id
			WHERE g.id = ${id} AND f.account_id = ${owner}
			LIMIT 1
		`);
		if (!identity) return null;
		if (identity.run_id) {
			if (!lease || lease.runId !== identity.run_id) {
				throw new ArtifactRepositoryError('stale', 'artifact run lease is required');
			}
			const run = await lockArtifactRunLease(
				tx,
				{
					accountId: owner,
					runId: safeText(lease.runId, 'runId', 256),
					tenantKey: safeText(lease.tenantKey, 'tenantKey', 256),
					leaseOwner: safeText(lease.leaseOwner, 'leaseOwner', 256),
					leaseToken: safeText(lease.leaseToken, 'leaseToken', 256)
				},
				now
			);
			if (run.conversation_id !== identity.conversation_id || run.assistant_message_id !== identity.source_message_id) {
				throw new ArtifactRepositoryError('conflict', 'artifact revision is not bound to this run');
			}
		}
		const rows = await tx.execute(sql`
			SELECT f.id, r.id AS revision_id, r.revision, f.kind, f.title, r.status,
				f.source_message_id, f.created_at, r.updated_at, r.spec_json, r.error_code, r.error_message,
				(r.spec_json::jsonb->>'fixture')::boolean AS fixture,
				pa.id AS preview_asset_id, pa.mime_type AS preview_mime_type, pa.size_bytes AS preview_size_bytes,
				pa.width AS preview_width, pa.height AS preview_height
			FROM artifact_upload_grants g
			JOIN artifact_revisions r ON r.id = g.revision_id
			JOIN artifact_families f ON f.id = r.family_id
			LEFT JOIN artifact_assets pa ON pa.revision_id = r.id AND pa.role = 'preview'
			WHERE g.id = ${id} AND g.state = 'consumed' AND r.status = 'ready' AND f.account_id = ${owner}
			LIMIT 1
		`);
		return rows[0] ? summaryFromRow(rows[0]) : null;
	});
}

export async function recordArtifactVerification(input: {
	grantId?: string | null;
	verified: boolean;
	objectKey: string;
	objectVersion: string;
	result?: VerifiedArtifactObject;
	reasonCode?: string;
	details?: Record<string, unknown>;
}): Promise<void> {
	const result = input.result;
	await db.insert(artifactVerifications).values({
		id: newId(),
		grantId: input.grantId ?? null,
		objectKey: input.objectKey,
		objectVersion: input.objectVersion,
		status: input.verified ? 'verified' : 'rejected',
		mimeType: result?.contentType ?? null,
		sizeBytes: result?.bytes ?? null,
		checksumSha256: result?.checksumSha256 ?? null,
		width: result?.dimensions?.width ?? null,
		height: result?.dimensions?.height ?? null,
		reasonCode: input.reasonCode ?? null,
		detailsJson: JSON.stringify(input.details ?? {}),
		createdAt: Date.now()
	});
}

export async function finalizeArtifactReady(input: {
	accountId: string;
	grantId: string;
	objectKey: string;
	objectVersion: string;
	verified: VerifiedArtifactObject;
	now?: number;
	lease?: { runId: string; tenantKey: string; leaseOwner: string; leaseToken: string };
}): Promise<ArtifactSummary> {
	const accountId = safeText(input.accountId, 'accountId', 256);
	const grantId = safeText(input.grantId, 'grantId', 256);
	if (input.objectKey !== input.verified.key || input.objectVersion !== input.verified.version) {
		throw new ArtifactRepositoryError('conflict', 'verified object identity does not match finalization input');
	}
	const now = input.now ?? Date.now();
	return db.transaction(async (tx: any) => {
		// Read the run id first, then lock the run before the grant/revision. The
		// grant route and cancellation path use the same ordering, so lease
		// turnover cannot race a finalization commit.
		const [identity] = await tx.execute(sql`SELECT run_id, revision_id FROM artifact_upload_grants WHERE id = ${grantId}`);
		if (!identity) throw new ArtifactRepositoryError('not_found', 'artifact grant not found');
		let run: any = null;
		if (identity.run_id) {
			if (!input.lease || input.lease.runId !== identity.run_id) {
				throw new ArtifactRepositoryError('stale', 'artifact run lease is required');
			}
			run = await lockArtifactRunLease(tx, {
				accountId,
				runId: safeText(input.lease.runId, 'runId', 256),
				tenantKey: safeText(input.lease.tenantKey, 'tenantKey', 256),
				leaseOwner: safeText(input.lease.leaseOwner, 'leaseOwner', 256),
				leaseToken: safeText(input.lease.leaseToken, 'leaseToken', 256)
			}, now);
		}
		const [grantRow] = await tx.execute(sql`SELECT * FROM artifact_upload_grants WHERE id = ${grantId} FOR UPDATE`);
		if (!grantRow || grantRow.revision_id !== identity.revision_id) throw new ArtifactRepositoryError('not_found', 'artifact grant not found');
		const grant = await ownedRevision(tx, accountId, grantRow.revision_id);
		if (run && (run.conversation_id !== grant.conversation_id || run.assistant_message_id !== grant.source_message_id)) {
			throw new ArtifactRepositoryError('conflict', 'artifact revision is not bound to this run');
		}
		const existing = await tx.select().from(artifactAssets).where(and(eq(artifactAssets.revisionId, grant.id), eq(artifactAssets.role, grantRow.role))).limit(1);
		if (existing[0]) {
			if (grantRow.state === 'consumed' && grant.status === 'ready') {
				// Concurrent/retried finalizers may have produced a second
				// unreferenced immutable copy before this transaction acquired the
				// grant lock. The first committed asset remains authoritative.
				if (existing[0].objectKey !== input.objectKey || existing[0].objectVersion !== input.objectVersion) {
					throw new ArtifactRepositoryError('conflict', 'artifact asset is already finalized with another object version');
				}
				return await summaryForRevisionTx(tx, accountId, grant.id);
			}
			if (grantRow.state !== 'consumed' || existing[0].objectKey !== input.objectKey || existing[0].objectVersion !== input.objectVersion) {
				throw new ArtifactRepositoryError('conflict', 'artifact asset is already finalized with another object version');
			}
			// Idempotent finalize retry: the immutable asset row is the durable
			// source of truth after the grant has been consumed.
			return await summaryForRevisionTx(tx, accountId, grant.id);
		}
		if (Number(grantRow.expires_at) <= now || !['issued', 'uploaded'].includes(grantRow.state)) throw new ArtifactRepositoryError('stale', 'artifact grant is no longer usable');
		if (!grantRow.uploaded_object_version) throw new ArtifactRepositoryError('stale', 'artifact upload has not completed');
		if (input.objectKey === grantRow.staging_key && grantRow.uploaded_object_version !== input.verified.version) throw new ArtifactRepositoryError('conflict', 'artifact upload version changed');
		if (grantRow.final_key !== input.objectKey && grantRow.staging_key !== input.objectKey) throw new ArtifactRepositoryError('conflict', 'artifact object key is not bound to grant');
		if (input.objectKey === grantRow.final_key && grantRow.uploaded_object_version === input.verified.version) {
			throw new ArtifactRepositoryError('conflict', 'final object version must differ from staging upload');
		}
		if (input.verified.contentType !== grantRow.allowed_mime || input.verified.bytes > Number(grantRow.max_bytes) || (grantRow.exact_bytes !== null && input.verified.bytes !== Number(grantRow.exact_bytes))) throw new ArtifactRepositoryError('conflict', 'verified object does not match grant');
		if (grantRow.expected_sha256 && input.verified.checksumSha256 !== grantRow.expected_sha256) throw new ArtifactRepositoryError('conflict', 'verified object checksum does not match grant');
		const assetId = newId();
		await tx.insert(artifactAssets).values({ id: assetId, revisionId: grant.id, role: grantRow.role, objectKey: input.objectKey, objectVersion: input.verified.version, mimeType: input.verified.contentType, sizeBytes: input.verified.bytes, checksumSha256: input.verified.checksumSha256, width: input.verified.dimensions?.width ?? null, height: input.verified.dimensions?.height ?? null, createdAt: now, verifiedAt: now });
		await tx.update(artifactUploadGrants).set({ state: 'consumed', consumedAt: now }).where(and(eq(artifactUploadGrants.id, grantId), inArray(artifactUploadGrants.state, ['issued', 'uploaded'])));
		await tx.update(artifactRevisions).set({ status: 'ready', updatedAt: now, readyAt: now, errorCode: null, errorMessage: null }).where(eq(artifactRevisions.id, grant.id));
		// A late older revision must never move a family pointer backwards over
		// a newer revision created by the same conversation.
		await tx.execute(sql`
			UPDATE artifact_families f
			SET latest_revision_id = ${grant.id}, updated_at = ${now}
			WHERE f.id = ${grant.family_id}
			  AND (
				f.latest_revision_id IS NULL OR
				(SELECT revision FROM artifact_revisions WHERE id = f.latest_revision_id) <= ${grant.revision}
			  )
		`);
		return await summaryForRevisionTx(tx, accountId, grant.id);
	});
}

export async function markArtifactFailed(
	accountId: string,
	revisionId: string,
	code: string,
	message: string,
	now = Date.now(),
	generation?: { grantId: string; stagingKey: string; uploadedObjectVersion: string | null }
): Promise<void> {
	const safeCode = code.trim().slice(0, 80) || 'publication_failed';
	const safeMessage = message.trim().slice(0, 240) || 'The artifact could not be published.';
	await db.execute(sql`
		UPDATE artifact_revisions r SET status = 'failed', error_code = ${safeCode}, error_message = ${safeMessage}, updated_at = ${now}
		FROM artifact_families f
		WHERE r.id = ${revisionId}
			AND r.family_id = f.id
			AND f.account_id = ${accountId}
			AND r.status NOT IN ('ready', 'cancelled')
			${generation ? sql`
				AND EXISTS (
					SELECT 1
					FROM artifact_upload_grants g
					WHERE g.id = ${generation.grantId}
						AND g.revision_id = r.id
						AND g.staging_key = ${generation.stagingKey}
						AND g.uploaded_object_version = ${generation.uploadedObjectVersion}
						AND g.state IN ('issued', 'uploaded')
				)
			` : sql``}
	`);
}

export async function cancelArtifactRevision(accountId: string, revisionId: string, now = Date.now()): Promise<void> {
	await db.execute(sql`
		UPDATE artifact_revisions r SET status = 'cancelled', updated_at = ${now}, error_code = 'cancelled', error_message = 'Publishing was cancelled.'
		FROM artifact_families f WHERE r.id = ${revisionId} AND r.family_id = f.id AND f.account_id = ${accountId} AND r.status NOT IN ('ready', 'failed')
	`);
}

/** Local/demo path for deterministic inline chart/table/map cards. File-backed
 * assets still use the grant + verifier path; this only marks a validated,
 * bounded spec ready without inventing an object asset. */
export async function markInlineArtifactReady(accountId: string, revisionId: string, now = Date.now()): Promise<void> {
	await db.execute(sql`
		UPDATE artifact_revisions r SET status = 'ready', ready_at = ${now}, updated_at = ${now}, error_code = NULL, error_message = NULL
		FROM artifact_families f WHERE r.id = ${revisionId} AND r.family_id = f.id AND f.account_id = ${accountId} AND r.status IN ('draft', 'publishing')
	`);
}

async function summaryForRevisionTx(tx: any, accountId: string, revisionId: string): Promise<ArtifactSummary> {
	const rows = await tx.execute(sql`
		SELECT f.id, r.id AS revision_id, r.revision, f.kind, f.title, r.status,
		 f.source_message_id, f.created_at, r.updated_at, r.spec_json, r.error_code, r.error_message,
		 (r.spec_json::jsonb->>'fixture')::boolean AS fixture,
		 pa.id AS preview_asset_id, pa.mime_type AS preview_mime_type, pa.size_bytes AS preview_size_bytes,
		 pa.width AS preview_width, pa.height AS preview_height
		FROM artifact_revisions r JOIN artifact_families f ON f.id = r.family_id
		LEFT JOIN artifact_assets pa ON pa.revision_id = r.id AND pa.role = 'preview'
		WHERE r.id = ${revisionId} AND f.account_id = ${accountId}
		LIMIT 1
	`);
	if (!rows[0]) throw new ArtifactRepositoryError('not_found', 'artifact revision not found');
	return summaryFromRow(rows[0]);
}

export async function listArtifactSummariesForMessages(accountId: string, conversationId: string, messageIds: string[], limit = 100): Promise<ArtifactSummary[]> {
	const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
	if (!ids.length) return [];
	const rows = await db.execute(sql`
		SELECT f.id, r.id AS revision_id, r.revision, f.kind, f.title, r.status,
		 f.source_message_id, f.created_at, r.updated_at, r.spec_json, r.error_code, r.error_message,
		 (r.spec_json::jsonb->>'fixture')::boolean AS fixture,
		 pa.id AS preview_asset_id, pa.mime_type AS preview_mime_type, pa.size_bytes AS preview_size_bytes,
		 pa.width AS preview_width, pa.height AS preview_height
		FROM artifact_families f JOIN artifact_revisions r ON r.id = f.latest_revision_id
		LEFT JOIN artifact_assets pa ON pa.revision_id = r.id AND pa.role = 'preview'
		WHERE f.account_id = ${accountId} AND f.conversation_id = ${conversationId} AND f.source_message_id IN ${sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`}
		ORDER BY f.updated_at DESC, f.id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}
	`);
	return rows.map(summaryFromRow);
}

export async function listArtifactLibrary(accountId: string, conversationId: string, cursor: { updatedAt: number; id: string } | null = null, limit = 30): Promise<{ artifacts: ArtifactSummary[]; nextCursor: { updatedAt: number; id: string } | null }> {
	const pageLimit = Math.min(Math.max(limit, 1), 50);
	const rows = await db.execute(sql`
		SELECT f.id, r.id AS revision_id, r.revision, f.kind, f.title, r.status,
		 f.source_message_id, f.created_at, r.updated_at, r.spec_json, r.error_code, r.error_message,
		 (r.spec_json::jsonb->>'fixture')::boolean AS fixture,
		 pa.id AS preview_asset_id, pa.mime_type AS preview_mime_type, pa.size_bytes AS preview_size_bytes,
		 pa.width AS preview_width, pa.height AS preview_height
		FROM artifact_families f JOIN artifact_revisions r ON r.id = f.latest_revision_id
		LEFT JOIN artifact_assets pa ON pa.revision_id = r.id AND pa.role = 'preview'
		WHERE f.account_id = ${accountId} AND f.conversation_id = ${conversationId}
		${cursor ? sql`AND (f.updated_at < ${cursor.updatedAt} OR (f.updated_at = ${cursor.updatedAt} AND f.id < ${cursor.id}))` : sql``}
		ORDER BY f.updated_at DESC, f.id DESC LIMIT ${pageLimit + 1}
	`);
	const page = rows.slice(0, pageLimit).map(summaryFromRow);
	const last = page.at(-1);
	return { artifacts: page, nextCursor: rows.length > pageLimit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
}

export async function getArtifactDetail(accountId: string, conversationId: string, artifactId: string, revisionId?: string | null): Promise<ArtifactDetail | null> {
	const rows = await db.execute(sql`
		SELECT f.id, f.kind, f.title, f.source_message_id, f.created_at AS family_created_at,
		 r.id AS revision_id, r.revision, r.status, r.spec_json, r.updated_at, r.error_code, r.error_message,
		 (r.spec_json::jsonb->>'fixture')::boolean AS fixture,
		 a.id AS asset_id, a.role AS asset_role, a.mime_type AS asset_mime_type, a.size_bytes AS asset_size_bytes,
		 a.checksum_sha256 AS asset_checksum_sha256, a.width AS asset_width, a.height AS asset_height,
		 a.object_version AS asset_object_version
		FROM artifact_families f JOIN artifact_revisions r ON r.family_id = f.id
		LEFT JOIN artifact_assets a ON a.revision_id = r.id
		WHERE f.account_id = ${accountId} AND f.conversation_id = ${conversationId} AND f.id = ${artifactId}
		${revisionId ? sql`AND r.id = ${revisionId}` : sql`AND r.id = f.latest_revision_id`}
		ORDER BY a.role
	`);
	if (!rows[0]) return null;
	const row = rows[0];
	const spec = parseArtifactSpec(JSON.parse(row.spec_json));
	const summary = summaryFromRow({ ...row, id: row.id, revision_id: row.revision_id, kind: row.kind, title: row.title, status: row.status, source_message_id: row.source_message_id, created_at: row.family_created_at, updated_at: row.updated_at, error_code: row.error_code, error_message: row.error_message, fixture: row.fixture });
	const assets = rows.filter((item: any) => item.asset_id).map((item: any) => ({ id: item.asset_id, role: item.asset_role, mimeType: item.asset_mime_type, sizeBytes: Number(item.asset_size_bytes), checksumSha256: item.asset_checksum_sha256, width: item.asset_width === null ? null : Number(item.asset_width), height: item.asset_height === null ? null : Number(item.asset_height), objectVersion: item.asset_object_version }));
	const preview = assets.find((item: ArtifactDetail['assets'][number]) => item.role === 'preview');
	return {
		...summary,
		preview: preview ? { assetId: preview.id, mimeType: preview.mimeType, sizeBytes: preview.sizeBytes, width: preview.width, height: preview.height } : null,
		spec,
		assets
	};
}

export async function getArtifactAssetOwner(accountId: string, conversationId: string, artifactId: string, revisionId: string, assetId: string): Promise<{ key: string; version: string; mimeType: string; filename: string } | null> {
	const rows = await db.execute(sql`
		SELECT a.object_key, a.object_version, a.mime_type, f.title, f.kind
		FROM artifact_assets a JOIN artifact_revisions r ON r.id = a.revision_id JOIN artifact_families f ON f.id = r.family_id
		WHERE a.id = ${assetId} AND r.id = ${revisionId} AND f.id = ${artifactId} AND f.account_id = ${accountId} AND f.conversation_id = ${conversationId} AND r.status = 'ready'
		LIMIT 1
	`);
	const row = rows[0];
	return row ? { key: row.object_key, version: row.object_version, mimeType: row.mime_type, filename: `${String(row.title || 'artifact').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'artifact'}.${row.mime_type === 'image/png' ? 'png' : row.mime_type === 'text/csv' ? 'csv' : 'bin'}` } : null;
}

export async function attachArtifactReferencesToEvent(accountId: string, runId: string, revisionId: string, cursor: number, now = Date.now()): Promise<void> {
	if (!Number.isSafeInteger(cursor) || cursor < 1) {
		throw new ArtifactRepositoryError('invalid_input', 'artifact event cursor must be a positive integer');
	}
	await db.transaction(async (tx: any) => {
		// This helper is intentionally stricter than the low-level reference
		// upsert. A reference is provenance for one persisted artifact.ready
		// event; accepting an arbitrary caller-supplied cursor would let a
		// later reader mistake an unrelated event for the publication point.
		const [event] = await tx.execute(sql`
			SELECT e.event_type, e.data_json, h.account_id, h.conversation_id, h.assistant_message_id
			FROM hermes_run_events e
			JOIN hermes_runs h ON h.id = e.run_id
			WHERE e.run_id = ${runId}
				AND e.account_id = ${accountId}
				AND h.account_id = ${accountId}
				AND e.cursor = ${cursor}
			FOR UPDATE OF e, h
		`);
		if (!event) throw new ArtifactRepositoryError('not_found', 'run or artifact event not found');
		if (event.event_type !== 'artifact.ready') {
			throw new ArtifactRepositoryError('conflict', 'artifact reference must point to an artifact.ready event');
		}
		let eventData: unknown;
		try {
			eventData = JSON.parse(String(event.data_json || '{}'));
		} catch {
			throw new ArtifactRepositoryError('conflict', 'artifact.ready event data is invalid');
		}
		const eventArtifactRevisionId =
			eventData && typeof eventData === 'object' && !Array.isArray(eventData) &&
			typeof (eventData as Record<string, unknown>).artifact_revision_id === 'string'
				? ((eventData as Record<string, unknown>).artifact_revision_id as string).trim()
				: '';
		if (!eventArtifactRevisionId || eventArtifactRevisionId !== revisionId) {
			throw new ArtifactRepositoryError('conflict', 'artifact.ready event does not identify this revision');
		}

		const [owned] = await tx.execute(sql`
			SELECT r.id
			FROM artifact_revisions r
			JOIN artifact_families f ON f.id = r.family_id
			WHERE r.id = ${revisionId}
				AND r.status = 'ready'
				AND f.account_id = ${accountId}
				AND f.conversation_id = ${event.conversation_id}
				AND f.source_message_id = ${event.assistant_message_id}
			FOR UPDATE OF r, f
		`);
		if (!owned) throw new ArtifactRepositoryError('not_found', 'artifact or run not found');
		await tx.insert(hermesRunArtifactRefs).values({ runId, revisionId, cursor, createdAt: now }).onConflictDoUpdate({
			target: [hermesRunArtifactRefs.runId, hermesRunArtifactRefs.revisionId],
			set: { cursor: sql`GREATEST(${hermesRunArtifactRefs.cursor}, EXCLUDED.cursor)`, createdAt: now }
		});
	});
}
