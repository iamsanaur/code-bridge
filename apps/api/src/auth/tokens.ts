import type { Db } from '../db/pool.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import type { TokenPair } from '@codebridge/protocol';

export interface AuthContext {
  userId: string;
  authSessionId: string;
}

export interface TokenConfig {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

/**
 * Opaque bearer tokens backed by the auth_sessions table.
 *
 * - Access tokens are short-lived and checked against the DB on every request,
 *   so revocation (logout, device loss, account deletion) is immediate.
 * - Refresh tokens rotate on every use. Re-use of an already-rotated refresh token
 *   indicates theft; the whole session is revoked (OAuth 2.0 Security BCP §4.14).
 */
export class TokenService {
  constructor(
    private readonly db: Db,
    private readonly cfg: TokenConfig,
  ) {}

  private newPair() {
    const accessToken = generateToken('cba');
    const refreshToken = generateToken('cbr');
    const now = Date.now();
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(now + this.cfg.accessTtlSeconds * 1000),
      refreshExpiresAt: new Date(now + this.cfg.refreshTtlSeconds * 1000),
    };
  }

  private static dto(p: ReturnType<TokenService['newPair']>): TokenPair {
    return {
      accessToken: p.accessToken,
      refreshToken: p.refreshToken,
      accessExpiresAt: p.accessExpiresAt.toISOString(),
      refreshExpiresAt: p.refreshExpiresAt.toISOString(),
    };
  }

  async issue(userId: string, userAgent: string | undefined): Promise<TokenPair> {
    const p = this.newPair();
    await this.db.query(
      `INSERT INTO auth_sessions (user_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        hashToken(p.accessToken),
        hashToken(p.refreshToken),
        p.accessExpiresAt,
        p.refreshExpiresAt,
        userAgent?.slice(0, 256) ?? null,
      ],
    );
    return TokenService.dto(p);
  }

  async verifyAccess(token: string): Promise<AuthContext | null> {
    if (!token.startsWith('cba_')) return null;
    const { rows } = await this.db.query<{ id: string; user_id: string }>(
      `UPDATE auth_sessions SET last_used_at = now()
        WHERE access_hash = $1 AND revoked_at IS NULL AND access_expires_at > now()
        RETURNING id, user_id`,
      [hashToken(token)],
    );
    const row = rows[0];
    return row ? { userId: row.user_id, authSessionId: row.id } : null;
  }

  /** Returns a new pair, or null if the refresh token is invalid/expired/reused. */
  async refresh(refreshToken: string, ip: string | undefined): Promise<TokenPair | null> {
    if (!refreshToken.startsWith('cbr_')) return null;
    const h = hashToken(refreshToken);
    const p = this.newPair();
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE auth_sessions
          SET prev_refresh_hash = refresh_hash, refresh_hash = $2, access_hash = $3,
              access_expires_at = $4, refresh_expires_at = $5, last_used_at = now()
        WHERE refresh_hash = $1 AND revoked_at IS NULL AND refresh_expires_at > now()
        RETURNING id`,
      [
        h,
        hashToken(p.refreshToken),
        hashToken(p.accessToken),
        p.accessExpiresAt,
        p.refreshExpiresAt,
      ],
    );
    if (rows[0]) return TokenService.dto(p);

    // Reuse detection: a rotated-out refresh token was presented again.
    const reused = await this.db.query<{ id: string; user_id: string }>(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'refresh_reuse'
        WHERE prev_refresh_hash = $1 AND revoked_at IS NULL RETURNING id, user_id`,
      [h],
    );
    if (reused.rows[0]) {
      await audit(this.db, {
        action: 'auth.refresh_reuse_detected',
        userId: reused.rows[0].user_id,
        ip: ip ?? null,
      });
    }
    return null;
  }

  async revoke(authSessionId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [authSessionId, reason],
    );
  }
}
