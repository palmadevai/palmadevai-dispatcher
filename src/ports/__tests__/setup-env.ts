/**
 * Vitest setup — populate the required env vars BEFORE any test file imports
 * `env.ts` transitively (providers/* and dispatch/* import it). `env.ts`
 * validates+parses `process.env` at module-load time and `process.exit(1)`s
 * on a missing required var, so this has to run first.
 */
process.env.NODE_ENV ??= 'test';
process.env.REDIS_PASSWORD ??= 'test-redis-password';
process.env.APPDB_PASSWORD ??= 'test-appdb-password';
process.env.META_WA_BEARER_TOKEN ??= 'test-meta-bearer-token';
process.env.META_WA_APP_SECRET ??= 'test-meta-app-secret';
process.env.META_WA_WABA_ID ??= 'test-waba-id';
process.env.CLIENT_SLUG ??= 'test-client';
process.env.DOMAIN ??= 'test.example.com';
