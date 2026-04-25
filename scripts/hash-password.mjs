#!/usr/bin/env node
// Usage: pnpm hash-password '<password>'
//        node scripts/hash-password.mjs '<password>'
import { hash } from '@node-rs/argon2';

const pw = process.argv[2];
if (!pw) {
	console.error('usage: node scripts/hash-password.mjs <password>');
	process.exit(2);
}

const out = await hash(pw, {
	algorithm: 2, // Argon2id
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
});
process.stdout.write(out + '\n');
