import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { LIMITS } from '@codebridge/protocol';
import { ZodError } from 'zod';
import type { Env } from './env.js';
import type { Db } from './db/pool.js';
import { TokenService, type AuthContext } from './auth/tokens.js';
import { loggerOptions } from './lib/logger.js';
import { HttpError, unauthorized } from './lib/errors.js';
import { SecretBox } from './lib/secretBox.js';
import type { DeviceIdentity } from './lib/deviceAuth.js';
import { bearer } from './lib/deviceAuth.js';
import { Relay } from './relay/relay.js';
import { registerWebSockets } from './relay/ws.js';
import { authRoutes } from './routes/auth.js';
import { pairingRoutes } from './routes/pairing.js';
import { deviceRoutes } from './routes/devices.js';
import { sessionRoutes } from './routes/sessions.js';
import { credentialRoutes } from './routes/credentials.js';
import { cloudRoutes } from './routes/cloud.js';
import { CloudSessionManager, type CloudProviderFactory } from './cloud/manager.js';
import { anthropicProviderFactory } from './cloud/anthropicProvider.js';

export interface AppContext {
  env: Env;
  db: Db;
  tokens: TokenService;
  relay: Relay;
  secretBox: SecretBox | null;
  cloud: CloudSessionManager;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    auth?: AuthContext;
    device?: DeviceIdentity;
  }
}

export interface BuildOptions {
  env: Env;
  db: Db;
  /** Injected in tests to mock Anthropic's Managed Agents API. */
  cloudProviderFactory?: CloudProviderFactory;
}

export async function buildApp({
  env,
  db,
  cloudProviderFactory,
}: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(env.LOG_LEVEL),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  const tokens = new TokenService(db, {
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  });
  const relay = new Relay(db, app.log, env.COMMAND_ACK_TIMEOUT_MS);
  const secretBox = env.CREDENTIAL_ENCRYPTION_KEY
    ? new SecretBox(env.CREDENTIAL_ENCRYPTION_KEY, env.CREDENTIAL_KEY_VERSION)
    : null;
  const cloud = new CloudSessionManager({
    db,
    relay,
    secretBox,
    log: app.log,
    providerFactory: cloudProviderFactory ?? anthropicProviderFactory,
    enabled: env.CLOUD_SESSIONS_ENABLED,
    defaults: {
      model: env.CLOUD_DEFAULT_MODEL,
      budgetCents: env.CLOUD_DEFAULT_BUDGET_CENTS,
      maxConcurrent: env.CLOUD_MAX_CONCURRENT,
      maxSessionMinutes: env.CLOUD_MAX_SESSION_MINUTES,
    },
  });
  relay.cloudReplay = (sessionId, afterSeq, conn) => cloud.replay(sessionId, afterSeq, conn);
  app.decorate('ctx', { env, db, tokens, relay, secretBox, cloud });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : false,
    credentials: false,
  });
  if (env.RATE_LIMIT_ENABLED)
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: LIMITS.maxFrameBytes } });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const token = bearer(req.headers.authorization);
    const auth = token ? await tokens.verifyAccess(token) : null;
    if (!auth) throw unauthorized();
    req.auth = auth;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ code: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        code: 'validation_error',
        message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({
        code: (err as { code?: string }).code ?? 'bad_request',
        message: (err as Error).message,
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'internal', message: 'Internal server error' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(pairingRoutes);
  await app.register(deviceRoutes);
  await app.register(sessionRoutes);
  await app.register(credentialRoutes);
  await app.register(cloudRoutes);
  await registerWebSockets(app);

  app.addHook('onClose', async () => {
    cloud.shutdown();
    relay.shutdown();
  });

  return app;
}
