import { createClient } from '@supabase/supabase-js';

const BUCKET = 'newsroom-documents';
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['application/pdf'];

const url = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceRoleKey) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
	process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
	auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const desired = {
	public: false,
	fileSizeLimit: MAX_FILE_SIZE,
	allowedMimeTypes: ALLOWED_MIME_TYPES
};

const existing = await supabase.storage.getBucket(BUCKET);
if (existing.error) {
	const created = await supabase.storage.createBucket(BUCKET, desired);
	if (created.error) {
		console.error(`Could not provision ${BUCKET}: ${created.error.message}`);
		process.exit(1);
	}
} else {
	const updated = await supabase.storage.updateBucket(BUCKET, desired);
	if (updated.error) {
		console.error(`Could not configure ${BUCKET}: ${updated.error.message}`);
		process.exit(1);
	}
}

const verified = await supabase.storage.getBucket(BUCKET);
const bucket = verified.data;
if (
	verified.error ||
	!bucket ||
	bucket.public ||
	bucket.file_size_limit !== MAX_FILE_SIZE ||
	JSON.stringify(bucket.allowed_mime_types ?? []) !== JSON.stringify(ALLOWED_MIME_TYPES)
) {
	console.error(`Could not verify ${BUCKET}.`);
	process.exit(1);
}

console.log(`${BUCKET} is private and restricted to PDFs up to 20 MB.`);
