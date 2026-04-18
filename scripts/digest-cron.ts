import cron from "node-cron";

const BASE_URL = process.env.NEWSCRAFT_BASE_URL ?? "http://localhost:3000";
const CRON_EXPRESSION = process.env.DIGEST_CRON ?? "0 7 * * *";
const CRON_SECRET = process.env.CRON_SECRET;

if (!CRON_SECRET) {
  console.error("DIGEST CRON: CRON_SECRET is not set. Exiting.");
  process.exit(1);
}

async function runDigest(reason: string) {
  console.log(`[${new Date().toISOString()}] Digest run (${reason})`);
  try {
    const response = await fetch(`${BASE_URL}/api/digest/run`, {
      method: "POST",
      headers: { "x-cron-secret": CRON_SECRET! },
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(`  ✓ success — ${JSON.stringify(body)}`);
    } else {
      console.error(`  ✗ ${response.status} — ${JSON.stringify(body)}`);
    }
  } catch (error) {
    console.error(`  ✗ transport error:`, error);
  }
}

if (!cron.validate(CRON_EXPRESSION)) {
  console.error(`Invalid cron expression: "${CRON_EXPRESSION}"`);
  process.exit(1);
}

console.log(
  `News Monitor cron scheduled: "${CRON_EXPRESSION}" → POST ${BASE_URL}/api/digest/run`,
);

cron.schedule(CRON_EXPRESSION, () => runDigest("scheduled"));

if (process.argv.includes("--now")) {
  runDigest("--now flag").then(() => process.exit(0));
}
