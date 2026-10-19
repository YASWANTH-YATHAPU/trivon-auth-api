import jwt from 'jsonwebtoken';
import { ACCOUNT_TYPES } from './account-types.js';
import { AuthError } from './errors.js';
import { AuthService } from './auth-service.js';
import { hashOpaqueToken, InvalidAccessTokenClaimsError, verifyAccessToken } from './tokens.js';

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function isJwtValidationError(error) {
  return error instanceof jwt.JsonWebTokenError
    || error instanceof jwt.TokenExpiredError
    || error instanceof jwt.NotBeforeError;
}

export function createAuthenticationMiddleware({ getPool, env = process.env }) {
  return async (req, res, next) => {
    const authorization = req.get('authorization');
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    if (!match) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');

    let identity;
    try {
      const payload = verifyAccessToken(match[1], env);
      if (!ACCOUNT_TYPES.includes(payload.userType)) {
        return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
      }
      if (['SELLER', 'SELLER_USER'].includes(payload.userType) && !/^\d+$/.test(String(payload.sellerId ?? ''))) {
        return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
      }
      if (!['SELLER', 'SELLER_USER'].includes(payload.userType) && payload.sellerId !== null) {
        return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
      }
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, session_id, user_id, user_type, seller_id, is_revoked,
                (access_token_expires_at > UTC_TIMESTAMP()) AS is_unexpired
         FROM jwt_tokens WHERE access_token_hash = ? LIMIT 1`,
        [hashOpaqueToken(match[1])],
      );
      const record = rows[0];
      if (
        !record
        || record.is_revoked
        || !record.is_unexpired
        || String(record.user_id) !== payload.sub
        || record.user_type !== payload.userType
        || String(record.session_id) !== payload.sid
        || (record.seller_id == null ? null : String(record.seller_id)) !== payload.sellerId
      ) {
        return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
      }
      if (payload.userType === 'SELLER' && payload.sellerId !== payload.sub) {
        return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
      }

      const account = await new AuthService({ pool, env }).getCurrentAccount({
        userId: payload.sub,
        userType: payload.userType,
        sellerId: payload.sellerId,
      });
      identity = {
        userId: payload.sub,
        userType: payload.userType,
        sellerId: payload.sellerId,
        sessionId: payload.sid,
        account,
      };
    } catch (error) {
      if (isJwtValidationError(error)) {
        return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
      }
      if (error instanceof InvalidAccessTokenClaimsError) {
        return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
      }
      if (error instanceof AuthError && error.status === 401) {
        return sendError(res, 401, error.code, error.message);
      }
      return sendError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Authentication service is unavailable.');
    }

    req.auth = identity;
    return next();
  };
}

export function requirePermission(permission) {
  if (typeof permission !== 'string' || permission.length < 1 || permission.length > 150) {
    throw new TypeError('A valid permission name is required.');
  }

  return async (req, res, next) => {
    if (!req.auth) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required.');
    try {
      const { userId, userType, sellerId } = req.auth;
      const pool = req.app.locals.databasePoolProvider();
      const [rows] = userType === 'SELLER_USER'
        ? await pool.query(
          `SELECT 1 AS allowed
           FROM seller_user_roles sur
           JOIN seller_users su ON su.id = sur.seller_user_id
           JOIN roles r ON r.id = sur.role_id AND r.scope_type = 'SELLER'
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE su.id = ? AND su.seller_id = ? AND p.name = ? LIMIT 1`,
          [userId, sellerId, permission],
        )
        : await pool.query(
          `SELECT 1 AS allowed
           FROM global_account_roles gar
           JOIN roles r ON r.id = gar.role_id AND r.scope_type = 'GLOBAL'
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE gar.user_id = ? AND gar.user_type = ? AND p.name = ? LIMIT 1`,
          [userId, userType, permission],
        );
      if (rows.length === 0) return sendError(res, 403, 'FORBIDDEN', 'Permission denied.');
      return next();
    } catch {
      return sendError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Authorization service is unavailable.');
    }
  };
}

export function requireSellerVerified(req, res, next) {
  if (!req.auth || !['SELLER', 'SELLER_USER'].includes(req.auth.userType)) {
    return sendError(res, 403, 'FORBIDDEN', 'Seller access is required.');
  }
  if (req.auth.account.verificationStatus !== 'APPROVED') {
    return sendError(res, 403, 'SELLER_VERIFICATION_REQUIRED', 'Seller verification is required for this operation.');
  }
  return next();
}

export function requireSellerOwner(req, res, next) {
  if (!req.auth || req.auth.userType !== 'SELLER') {
    return sendError(res, 403, 'FORBIDDEN', 'Seller owner access is required.');
  }
  return next();
}

export function requireSellerTenant({ paramName = 'sellerId' } = {}) {
  return (req, res, next) => {
    const auth = req.auth;
    if (!auth || !['SELLER', 'SELLER_USER'].includes(auth.userType) || auth.sellerId == null) {
      return sendError(res, 403, 'FORBIDDEN', 'Seller access is required.');
    }

    const requestedSellerIds = [
      req.params?.[paramName],
      req.body?.sellerId,
      req.query?.sellerId,
    ].filter((value) => value !== undefined);
    if (requestedSellerIds.some((value) => String(value) !== String(auth.sellerId))) {
      return sendError(res, 403, 'CROSS_SELLER_ACCESS_DENIED', 'Access to another seller is forbidden.');
    }

    req.sellerId = String(auth.sellerId);
    return next();
  };
}
