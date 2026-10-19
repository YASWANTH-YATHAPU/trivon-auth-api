import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AccountService } from '../auth/account-service.js';
import { AuthService } from '../auth/auth-service.js';
import {
  createAuthenticationMiddleware,
  requireSellerOwner,
  requireSellerTenant,
  requireSellerVerified,
} from '../auth/middleware.js';
import { AuthError } from '../auth/errors.js';
import { createLazyDatabasePoolProvider } from '../config/database.js';

const loginSchema = z.object({
  userType: z.enum(['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'SELLER', 'CUSTOMER_CARE', 'SELLER_USER']),
  email: z.string().trim().email().max(255).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(200).refine((password) => Buffer.byteLength(password, 'utf8') <= 72),
  sellerId: z.string().refine((id) => /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n).optional(),
}).strict().superRefine((input, context) => {
  if (input.userType === 'SELLER_USER' && input.sellerId === undefined) {
    context.addIssue({ code: 'custom', path: ['sellerId'], message: 'Required for seller users.' });
  }
  if (input.userType !== 'SELLER_USER' && input.sellerId !== undefined) {
    context.addIssue({ code: 'custom', path: ['sellerId'], message: 'Only accepted for seller users.' });
  }
});

const refreshSchema = z.object({ refreshToken: z.string().min(40).max(128) }).strict();
const sellerRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(150),
  email: z.string().trim().email().max(255).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(200).refine((password) => {
    const length = Buffer.byteLength(password, 'utf8');
    return length >= 12 && length <= 72;
  }),
  mobileNumber: z.string().trim().min(1).max(20).optional(),
  businessName: z.string().trim().min(1).max(255),
  gstId: z.string().trim().max(50).transform((gstId) => gstId ? gstId.toUpperCase() : null).optional(),
}).strict();
const sellerUserSchema = z.object({
  email: z.string().trim().email().max(255).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(200).refine((password) => {
    const length = Buffer.byteLength(password, 'utf8');
    return length >= 12 && length <= 72;
  }),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  mobileNumber: z.string().trim().min(1).max(20).optional(),
}).strict();
const sellerUserStatusSchema = z.object({ isActive: z.boolean() }).strict();
const userIdSchema = z.string().regex(/^[1-9]\d{0,19}$/).refine((id) => /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } },
});

const sellerRegistrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many registration attempts. Try again later.' } },
});

const getDefaultPool = createLazyDatabasePoolProvider();

const defaultGetService = () => new AuthService({ pool: getDefaultPool() });
const defaultGetAccountService = () => new AccountService({ pool: getDefaultPool() });
const defaultAuthenticate = createAuthenticationMiddleware({ getPool: getDefaultPool });

function sendValidationError(res, error) {
  return res.status(400).json({
    error: {
      code: 'INVALID_REQUEST',
      message: 'The request body is invalid.',
      fields: error.issues.map((issue) => ({ field: issue.path.join('.'), code: issue.code })),
    },
  });
}

function sendHandlerError(res, error) {
  if (error instanceof AuthError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  return res.status(503).json({
    error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service is unavailable.' },
  });
}

export function createAuthRouter({
  getService = defaultGetService,
  getAccountService = defaultGetAccountService,
  authenticate = defaultAuthenticate,
  limiter = loginLimiter,
  registrationLimiter = sellerRegistrationLimiter,
} = {}) {
  const router = Router();

  router.post('/login', limiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.status(200).json(await getService().login(parsed.data, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }));
    } catch (error) {
      return sendHandlerError(res, error);
    }
  });

  router.post('/sellers/register', registrationLimiter, async (req, res) => {
    const parsed = sellerRegistrationSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.status(201).json(await getAccountService().registerSeller(parsed.data));
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: { code: 'SELLER_REGISTRATION_CONFLICT', message: 'The seller registration conflicts with an existing account.' },
        });
      }
      return sendHandlerError(res, error);
    }
  });

  router.post('/seller-users', authenticate, requireSellerOwner, requireSellerTenant(), requireSellerVerified, async (req, res) => {
    const parsed = sellerUserSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.status(201).json({ user: await getAccountService().createSellerUser(req.sellerId, parsed.data) });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: { code: 'SELLER_USER_CONFLICT', message: 'The seller user conflicts with an existing account.' } });
      }
      return sendHandlerError(res, error);
    }
  });

  router.get('/seller-users', authenticate, requireSellerOwner, requireSellerTenant(), requireSellerVerified, async (req, res) => {
    try {
      return res.status(200).json({ users: await getAccountService().listSellerUsers(req.sellerId) });
    } catch (error) {
      return sendHandlerError(res, error);
    }
  });

  router.patch('/seller-users/:userId/active', authenticate, requireSellerOwner, requireSellerTenant(), requireSellerVerified, async (req, res) => {
    if (!userIdSchema.safeParse(req.params.userId).success) {
      return sendValidationError(res, { issues: [{ path: ['userId'], code: 'invalid_format' }] });
    }
    const parsed = sellerUserStatusSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      const user = await getAccountService().setSellerUserActive(req.sellerId, req.params.userId, parsed.data.isActive);
      if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Seller user not found.' } });
      return res.status(200).json({ user });
    } catch (error) {
      return sendHandlerError(res, error);
    }
  });

  router.post('/refresh', async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.status(200).json(await getService().refresh(parsed.data.refreshToken, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }));
    } catch (error) {
      return sendHandlerError(res, error);
    }
  });

  router.post('/logout', async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      await getService().logout(parsed.data.refreshToken);
      return res.status(200).json({ status: 'ok' });
    } catch (error) {
      return sendHandlerError(res, error);
    }
  });

  router.get('/me', authenticate, (req, res) => res.status(200).json({ user: req.auth.account }));
  return router;
}

export default createAuthRouter();
