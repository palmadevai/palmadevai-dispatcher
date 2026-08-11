/**
 * Pino logger con redacción de secretos.
 * En dev: pretty-printed via pino-pretty. En prod: NDJSON a stdout/stderr
 * (Docker logs lo capta; cualquier log shipper downstream lo parsea).
 */
import pino from 'pino';
import { env } from '../env.js';

const isDev = env.NODE_ENV !== 'production';

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  base: {
    service: 'dispatcher',
    client_slug: env.CLIENT_SLUG,
    hostname_consumer: env.HOSTNAME,
  },
  // Redact paths donde NO debería loggear bearer tokens / passwords / app secrets.
  // Importante: estos paths se evalúan sobre objetos del log call, no sobre
  // las env vars directamente.
  redact: {
    paths: [
      '*.password',
      '*.token',
      '*.bearer',
      '*.bearerToken',
      '*.api_key',
      '*.apiKey',
      'env.REDIS_PASSWORD',
      'env.APPDB_PASSWORD',
      'env.META_WA_BEARER_TOKEN',
      'env.META_WA_APP_SECRET',
      'env.COCKPIT_INTERNAL_TOKEN',
      // Piso 1 (analysis-secretos-en-reposo.md): la master key abre TODAS las
      // credenciales del cliente, así que es el peor valor posible en un log.
      'env.SECRETS_MASTER_KEY',
      'env.SECRETS_MASTER_KEY_PREVIOUS',
      // La credencial en claro cuando el cockpit la manda a guardar.
      '*.credential',
      '*.secret',
      'headers.authorization',
    ],
    censor: '[REDACTED]',
  },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service,client_slug,hostname_consumer',
        },
      }
    : undefined,
});

export type Logger = typeof logger;
