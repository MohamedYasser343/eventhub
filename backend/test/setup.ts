// Loaded with --import before every test file. Tests are DESTRUCTIVE (they truncate
// tables), so they only ever run against a database whose name ends in "_test".
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is required to run tests (see backend/.env.example)");
const dbName = new URL(url).pathname.replace(/^\//, "");
if (!dbName.endsWith("_test")) throw new Error(`refusing to run tests against database "${dbName}": its name must end with _test`);
process.env["DATABASE_URL"] = url; // the app reads DATABASE_URL; tests point it at the test database

// The dev cache must never be touched by tests: REDIS_URL always comes from TEST_REDIS_URL
// (or is removed, which means "no cache"). Loopback only, since helpers delete keys.
delete process.env["CACHE_ENABLED"]; // a developer's local flag must not change what the suite tests
const redisUrl = process.env["TEST_REDIS_URL"];
if (redisUrl) {
  const host = new URL(redisUrl).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("TEST_REDIS_URL must point at localhost");
  process.env["REDIS_URL"] = redisUrl;
} else {
  delete process.env["REDIS_URL"];
}

// Lecture 14: the job queue has its own Redis. Tests use TEST_QUEUE_REDIS_URL only (loopback,
// since tests delete their own uniquely-prefixed keys); unset means the queue tests are skipped.
const queueUrl = process.env["TEST_QUEUE_REDIS_URL"];
if (queueUrl) {
  const host = new URL(queueUrl).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("TEST_QUEUE_REDIS_URL must point at localhost");
  process.env["QUEUE_REDIS_URL"] = queueUrl;
} else {
  delete process.env["QUEUE_REDIS_URL"];
}
