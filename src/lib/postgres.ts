/**
 * Postgres pool via `postgres` (slim ESM driver). NO usamos `pg` ni `psycopg`.
 * Tagged template literals nativos previenen SQL injection por default.
 *
 * `prepare: false` — desactiva statement cache. Más seguro para compat con
 * migrations DDL (ALTER, REINDEX, etc). Performance: postgres.js es bastante
 * rápido sin prepared statements; podemos activarlo después si hace falta.
 */
import postgres from 'postgres';
import { env } from '../env.js';

export const sql = postgres({
  host: env.APPDB_HOST,
  port: env.APPDB_PORT,
  user: env.APPDB_USER,
  password: env.APPDB_PASSWORD,
  database: env.APPDB_DATABASE,
  ssl: false,
  max: 10,
  idle_timeout: 30,
  prepare: false,
  // Schema search_path. Los workflows n8n del template asumen `bot` como
  // schema canónico; las queries del worker harán bot.* qualified anyway.
  connection: {
    search_path: `${env.DB_SCHEMA}, public`,
  },
});

export type SqlClient = typeof sql;
