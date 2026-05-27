/**
 * Conexión Redis para el worker.
 *
 * - `bullmqConnection`: objeto de connection options que se pasa a BullMQ
 *   Worker / Queue. NO instanciamos un Redis directamente porque BullMQ
 *   bundle internamente su propio ioredis (incompatibilidad nominal de tipos
 *   entre `ioredis` top-level y `bullmq/node_modules/ioredis`). Pasar options
 *   evita la colisión y BullMQ administra su propio pool.
 * - `rawRedis`: instancia ioredis directa para XGROUP / XPENDING / XLEN /
 *   pub-sub. No la usa BullMQ.
 *
 * Flags BullMQ-required (`maxRetriesPerRequest: null`, `enableReadyCheck:
 * false`) los aplica BullMQ automáticamente cuando recibe options object;
 * documentado en https://docs.bullmq.io/guide/connections.
 */
import { Redis } from 'ioredis';
import { env } from '../env.js';

const baseOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
};

/** Connection options para BullMQ (pasado a Worker/Queue). */
export const bullmqConnection = baseOptions;

/** Cliente raw para XGROUP / XPENDING / XLEN / pub-sub. */
export const rawRedis = new Redis(baseOptions);
