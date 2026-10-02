/**
 * Test preload, run before any test file is imported. Pins the database to
 * memory so tests can never touch a real `findr.db`, and supplies the
 * required environment so modules that validate it at import time load.
 * Service URLs and keys are settings; tests that need them store them.
 */

process.env.DATABASE_PATH = ":memory:";
process.env.BASE_URL ??= "http://localhost:3030";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-00";
