/**
 * Test preload, run before any test file is imported. Pins the database to
 * memory so tests can never touch a real `findr.db` — which also keeps the
 * auth secret in memory rather than in a file. Service URLs and keys are
 * settings; tests that need them store them.
 */

process.env.DATABASE_PATH = ":memory:";
