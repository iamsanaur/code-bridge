import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { agentToServerSchema, clientToServerSchema, parseFrame } from '@codebridge/protocol';
import { audit } from '../lib/audit.js';
import { authenticateDevice, bearer } from '../lib/deviceAuth.js';
import { TokenBucket } from '../lib/tokenBucket.js';
import type { ClientConn } from './relay.js';

const AUTH_TIMEOUT_MS = 5_000;
const LIVENESS_INTERVAL_MS = 30_000;
const SESSION_RECHECK_MS = 60_000;

/** Terminates sockets that stop answering protocol-level pings. */
function keepAlive(socket: WebSocket): () => void {
  let alive = true;
  socket.on('pong', () => (alive = true));
  const timer = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, LIVENESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

export async function registerWebSockets(app: FastifyInstance): Promise<void> {
  const { relay, db } = app.ctx;

  /**
   * Mac agent endpoint. Authenticated before the upgrade with the device credential
   * in the Authorization header (never in the URL, which may be logged by proxies).
   */
  app.get(
    '/v1/agent/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const identity = await authenticateDevice(db, bearer(req.headers.authorization));
        if (!identity) {
          await audit(db, { action: 'device.auth_failed', ip: req.ip });
          return reply
            .code(401)
            .send({ code: 'unauthorized', message: 'Invalid or revoked device credential' });
        }
        req.device = identity;
      },
    },
    (socket, req) => {
      const { deviceId, userId } = req.device!;
      const log = req.log.child({ deviceId });
      const bucket = new TokenBucket(2000, 1000);
      relay.attachAgent(deviceId, userId, socket);
      log.info('agent connected');
      const stopKeepAlive = keepAlive(socket);
      let queue = Promise.resolve();

      socket.on('message', (raw) => {
        if (!bucket.take()) {
          socket.close(4429, 'rate limit exceeded');
          return;
        }
        const parsed = parseFrame(agentToServerSchema, raw);
        if (!parsed.ok) {
          log.warn({ error: parsed.error }, 'invalid agent frame');
          return;
        }
        // Process sequentially so per-session event order is preserved.
        queue = queue
          .then(() => relay.handleAgentMessage(deviceId, parsed.value))
          .catch((err: unknown) => log.error({ err }, 'agent message handling failed'));
      });
      socket.on('close', () => {
        stopKeepAlive();
        void queue.then(() => relay.detachAgent(deviceId, socket)).catch(() => undefined);
        log.info('agent disconnected');
      });
    },
  );

  /**
   * Mobile client endpoint. The first frame must be `{type:"auth", token}` with a
   * valid access token; otherwise the socket is closed.
   */
  app.get('/v1/client/ws', { websocket: true }, (socket, req) => {
    let conn: ClientConn | null = null;
    const bucket = new TokenBucket(200, 50);
    const stopKeepAlive = keepAlive(socket);
    const authTimer = setTimeout(() => {
      if (!conn) socket.close(4401, 'authentication timeout');
    }, AUTH_TIMEOUT_MS);
    let queue = Promise.resolve();
    // Long-lived sockets re-check that the sign-in session is still valid (logout, deletion, reuse revocation).
    const recheck = setInterval(() => {
      if (!conn) return;
      const c = conn;
      void db
        .query(
          'SELECT 1 FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL AND refresh_expires_at > now()',
          [c.authSessionId],
        )
        .then((r) => {
          if (r.rowCount === 0) socket.close(4401, 'session ended');
        })
        .catch(() => undefined);
    }, SESSION_RECHECK_MS);

    socket.on('message', (raw) => {
      if (!bucket.take()) {
        socket.close(4429, 'rate limit exceeded');
        return;
      }
      const parsed = parseFrame(clientToServerSchema, raw);
      if (!parsed.ok) {
        socket.send(
          JSON.stringify({ type: 'error', code: 'invalid_message', message: parsed.error }),
        );
        return;
      }
      const msg = parsed.value;
      queue = queue
        .then(async () => {
          if (!conn) {
            if (msg.type !== 'auth') {
              socket.close(4401, 'authenticate first');
              return;
            }
            const auth = await app.ctx.tokens.verifyAccess(msg.token);
            if (!auth) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  code: 'unauthorized',
                  message: 'Invalid or expired token',
                }),
              );
              socket.close(4401, 'unauthorized');
              return;
            }
            clearTimeout(authTimer);
            conn = {
              id: randomUUID(),
              userId: auth.userId,
              authSessionId: auth.authSessionId,
              socket,
              subscriptions: new Set(),
            };
            relay.attachClient(conn);
            relay.sendToClient(conn, { type: 'auth.ok', userId: auth.userId });
            return;
          }
          await relay.handleClientMessage(conn, msg);
        })
        .catch((err: unknown) => req.log.error({ err }, 'client message handling failed'));
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(recheck);
      stopKeepAlive();
      if (conn) relay.detachClient(conn);
    });
  });
}
