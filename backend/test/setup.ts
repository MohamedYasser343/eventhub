// Loaded with --import before every test file. Tests are DESTRUCTIVE (they truncate
// tables), so they only ever run against a database whose name ends in "_test".
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is required to run tests (see backend/.env.example)");
const dbName = new URL(url).pathname.replace(/^\//, "");
if (!dbName.endsWith("_test")) throw new Error(`refusing to run tests against database "${dbName}": its name must end with _test`);
process.env["DATABASE_URL"] = url; // the app reads DATABASE_URL; tests point it at the test database
