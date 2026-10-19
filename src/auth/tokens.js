import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export class InvalidAccessTokenClaimsError extends Error {
  constructor() {
    super('Invalid access token claims.');
    this.name = 'InvalidAccessTokenClaimsError';
  }
}

export function readTokenConfig(env = process.env) {
  const secret = env.JWT_ACCESS_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes.');
  }

  const accessTtl = Number(env.JWT_ACCESS_TTL_SECONDS ?? 900);
  const refreshTtl = Number(env.REFRESH_TOKEN_TTL_SECONDS ?? 604800);
  if (!Number.isInteger(accessTtl) || accessTtl < 60 || accessTtl > 3600) {
    throw new Error('JWT_ACCESS_TTL_SECONDS must be between 60 and 3600.');
  }
  if (!Number.isInteger(refreshTtl) || refreshTtl < 3600 || refreshTtl > 2592000) {
    throw new Error('REFRESH_TOKEN_TTL_SECONDS must be between 3600 and 2592000.');
  }

  return {
    secret,
    issuer: env.JWT_ISSUER || 'trivon-auth-api',
    audience: env.JWT_AUDIENCE || 'trivon-api',
    accessTtl,
    refreshTtl,
  };
}

export function hashOpaqueToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionId() {
  return randomBytes(16).toString('hex');
}

export function createRefreshToken() {
  return randomBytes(32).toString('base64url');
}

export function issueAccessToken(account, sessionId, env = process.env, now = new Date()) {
  const config = readTokenConfig(env);
  const jti = randomUUID();
  const userId = String(account.id);
  const sellerId = account.userType === 'SELLER'
    ? String(account.id)
    : (account.seller_id == null ? null : String(account.seller_id));
  const token = jwt.sign(
    { userType: account.userType, sellerId, sid: sessionId, iat: Math.floor(now.getTime() / 1000) },
    config.secret,
    {
      algorithm: 'HS256',
      audience: config.audience,
      expiresIn: config.accessTtl,
      issuer: config.issuer,
      jwtid: jti,
      subject: userId,
    },
  );

  return {
    token,
    jti,
    hash: hashOpaqueToken(token),
    expiresAt: new Date(now.getTime() + config.accessTtl * 1000),
    expiresIn: config.accessTtl,
    sellerId,
  };
}

export function verifyAccessToken(token, env = process.env, now = new Date()) {
  const config = readTokenConfig(env);
  const payload = jwt.verify(token, config.secret, {
    algorithms: ['HS256'],
    audience: config.audience,
    issuer: config.issuer,
    clockTimestamp: Math.floor(now.getTime() / 1000),
  });

  if (
    payload === null
    || typeof payload !== 'object'
    || typeof payload.sub !== 'string'
    || !/^\d+$/.test(payload.sub)
    || typeof payload.jti !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.jti)
    || typeof payload.sid !== 'string'
    || !/^[a-f0-9]{32}$/.test(payload.sid)
    || typeof payload.userType !== 'string'
    || !Object.hasOwn(payload, 'sellerId')
    || (payload.sellerId !== null && typeof payload.sellerId !== 'string')
    || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp)
    || payload.exp <= payload.iat
  ) {
    throw new InvalidAccessTokenClaimsError();
  }

  return payload;
}
