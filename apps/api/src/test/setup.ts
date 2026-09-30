/**
 * Test preload, run before any test file is imported. Pins the database to
 * memory so tests can never touch a real `findr.db`, and supplies the
 * required environment so modules that validate it at import time load.
 */

process.env.DATABASE_PATH = ":memory:";
process.env.BASE_URL ??= "http://localhost:3030";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-00";
process.env.PROWLARR_URL = "http://prowlarr.test:9696";
process.env.PROWLARR_API_KEY = "test-prowlarr-key";
