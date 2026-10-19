import { randomBytes } from 'node:crypto';
import { ACCOUNT_TYPES, resolveAccountTable, validateLoginContext } from './account-types.js';
import { AuthError, invalidCredentialsError } from './errors.js';
import { passwordHasher } from './passwords.js';
import {
  createRefreshToken,
  createSessionId,
  hashOpaqueToken,
  issueAccessToken,
  readTokenConfig,
} from './tokens.js';

let dummyPasswordHash;

async function getDummyPasswordHash(hasher) {
  dummyPasswordHash ??= hasher.hash(randomBytes(32).toString('hex'));
  return dummyPasswordHash;
}

function publicAccount(account) {
  return {
    id: String(account.id),
    userType: account.userType,
    email: account.email,
    name: account.name ?? [account.first_name, account.last_name].filter(Boolean).join(' '),
    sellerId: account.userType === 'SELLER'
      ? String(account.id)
      : (account.seller_id == null ? null : String(account.seller_id)),
    verificationStatus: account.verification_status ?? null,
  };
}

function accountSelect(userType) {
  const table = resolveAccountTable(userType);
  if (!table) throw invalidCredentialsError();

  if (userType === 'SELLER_USER') {
    return `SELECT su.id, su.seller_id, su.email, su.password_hash, su.first_name, su.last_name,
                   su.is_active, s.is_active AS seller_is_active, s.verification_status
            FROM seller_users su JOIN sellers s ON s.id = su.seller_id`;
  }
  return `SELECT id, email, password_hash, name, is_active,
                 ${userType === 'SELLER' ? 'verification_status' : 'NULL AS verification_status'}
          FROM ${table}`;
}

async function findByLogin(connection, { userType, email, sellerId }) {
  const base = accountSelect(userType);
  const [rows] = userType === 'SELLER_USER'
    ? await connection.query(`${base} WHERE su.email = ? AND su.seller_id = ? LIMIT 1`, [email, sellerId])
    : await connection.query(`${base} WHERE email = ? LIMIT 1`, [email]);
  return rows[0] ? { ...rows[0], userType } : null;
}

async function findById(connection, { userType, userId, sellerId }) {
  const base = accountSelect(userType);
  const [rows] = userType === 'SELLER_USER'
    ? await connection.query(`${base} WHERE su.id = ? AND su.seller_id = ? LIMIT 1`, [userId, sellerId])
    : await connection.query(`${base} WHERE id = ? LIMIT 1`, [userId]);
  return rows[0] ? { ...rows[0], userType } : null;
}

function isActive(account) {
  return Boolean(account?.is_active) && (account.seller_is_active === undefined || Boolean(account.seller_is_active));
}

async function inTransaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    connection.release();
  }
}

function requestMetadata({ ip, userAgent }) {
  return {
    ip: typeof ip === 'string' ? ip.slice(0, 45) : null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 1000) : null,
  };
}

export class AuthService {
  constructor({ pool, env = process.env, hasher = passwordHasher, clock = () => new Date() }) {
    this.pool = pool;
    this.env = env;
    this.hasher = hasher;
    this.clock = clock;
  }

  async login(input, metadata = {}) {
    const contextError = validateLoginContext(input);
    if (contextError) throw new AuthError(400, 'INVALID_LOGIN_REQUEST', contextError);
    if (!ACCOUNT_TYPES.includes(input.userType)) throw invalidCredentialsError();

    const account = await findByLogin(this.pool, input);
    const storedHash = account?.password_hash ?? await getDummyPasswordHash(this.hasher);
    const passwordMatches = await this.hasher.compare(input.password, storedHash);
    if (!account || !passwordMatches || !isActive(account)) throw invalidCredentialsError();

    const config = readTokenConfig(this.env);
    const sessionId = createSessionId();
    const refreshToken = createRefreshToken();
    const access = issueAccessToken(account, sessionId, this.env, this.clock());
    const refreshExpiresAt = new Date(this.clock().getTime() + config.refreshTtl * 1000);
    const meta = requestMetadata(metadata);

    await inTransaction(this.pool, async (connection) => {
      const table = resolveAccountTable(account.userType);
      if (account.userType === 'SELLER_USER') {
        await connection.query('UPDATE seller_users SET last_login_at = UTC_TIMESTAMP() WHERE id = ? AND seller_id = ?', [account.id, account.seller_id]);
      } else {
        await connection.query(`UPDATE ${table} SET last_login_at = UTC_TIMESTAMP() WHERE id = ?`, [account.id]);
      }
      await this.insertTokens(connection, account, sessionId, access, refreshToken, refreshExpiresAt, meta);
    });

    return this.tokenResponse(account, access, refreshToken);
  }

  async refresh(refreshToken, metadata = {}) {
    if (typeof refreshToken !== 'string' || refreshToken.length < 40 || refreshToken.length > 128) {
      throw invalidCredentialsError();
    }
    const tokenHash = hashOpaqueToken(refreshToken);
    const config = readTokenConfig(this.env);
    const meta = requestMetadata(metadata);

    const result = await inTransaction(this.pool, async (connection) => {
      const [rows] = await connection.query(
        `SELECT id, session_id, user_id, user_type, seller_id, expires_at,
                (expires_at > UTC_TIMESTAMP()) AS is_unexpired, revoked_at
         FROM refresh_tokens WHERE token_hash = ? LIMIT 1 FOR UPDATE`,
        [tokenHash],
      );
      const stored = rows[0];
      if (!stored) return { rejected: true };
      if (stored.revoked_at) {
        // A rotated refresh token was replayed. Revoke every token in the
        // session, then commit that response before returning a generic 401.
        await this.revokeSession(connection, stored.session_id);
        return { rejected: true };
      }
      if (!stored.is_unexpired) return { rejected: true };

      const account = await findById(connection, {
        userType: stored.user_type,
        userId: stored.user_id,
        sellerId: stored.seller_id,
      });
      if (!isActive(account)) {
        await this.revokeSession(connection, stored.session_id);
        return { rejected: true };
      }

      const [update] = await connection.query(
        'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
        [stored.id],
      );
      if (update.affectedRows !== 1) return { rejected: true };

      const nextRefreshToken = createRefreshToken();
      const access = issueAccessToken(account, stored.session_id, this.env, this.clock());
      const refreshExpiresAt = new Date(this.clock().getTime() + config.refreshTtl * 1000);
      await this.insertTokens(connection, account, stored.session_id, access, nextRefreshToken, refreshExpiresAt, meta);
      return { response: this.tokenResponse(account, access, nextRefreshToken) };
    });
    if (result.rejected) throw invalidCredentialsError();
    return result.response;
  }

  async logout(refreshToken) {
    if (typeof refreshToken !== 'string' || refreshToken.length < 40 || refreshToken.length > 128) {
      throw invalidCredentialsError();
    }
    const tokenHash = hashOpaqueToken(refreshToken);
    await inTransaction(this.pool, async (connection) => {
      const [rows] = await connection.query(
        'SELECT id, session_id, revoked_at FROM refresh_tokens WHERE token_hash = ? LIMIT 1 FOR UPDATE',
        [tokenHash],
      );
      const stored = rows[0];
      if (!stored || stored.revoked_at) throw invalidCredentialsError();
      await this.revokeSession(connection, stored.session_id);
    });
  }

  async getCurrentAccount(identity) {
    const account = await findById(this.pool, {
      userType: identity.userType,
      userId: identity.userId,
      sellerId: identity.sellerId,
    });
    if (!isActive(account)) throw new AuthError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    return publicAccount(account);
  }

  async insertTokens(connection, account, sessionId, access, refreshToken, refreshExpiresAt, meta) {
    const userId = String(account.id);
    const sellerId = access.sellerId;
    await connection.query(
      `INSERT INTO jwt_tokens
        (session_id, user_id, user_type, seller_id, access_token_hash, token_type, issued_at, access_token_expires_at, refresh_token_expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, 'Bearer', ?, ?, ?, ?, ?)`,
      [sessionId, userId, account.userType, sellerId, access.hash, this.clock(), access.expiresAt, refreshExpiresAt, meta.ip, meta.userAgent],
    );
    await connection.query(
      `INSERT INTO refresh_tokens
        (session_id, user_id, user_type, seller_id, token_hash, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, userId, account.userType, sellerId, hashOpaqueToken(refreshToken), refreshExpiresAt, meta.ip, meta.userAgent],
    );
  }

  async revokeSession(connection, sessionId) {
    await connection.query(
      'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND revoked_at IS NULL',
      [sessionId],
    );
    await connection.query(
      'UPDATE jwt_tokens SET is_revoked = TRUE, revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND is_revoked = FALSE',
      [sessionId],
    );
  }

  tokenResponse(account, access, refreshToken) {
    return {
      accessToken: access.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      refreshToken,
      user: publicAccount(account),
    };
  }
}
