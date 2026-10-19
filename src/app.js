import express from 'express';
import helmet from 'helmet';
import { AccountService } from './auth/account-service.js';
import { AuthService } from './auth/auth-service.js';
import { createAuthenticationMiddleware } from './auth/middleware.js';
import { createLazyDatabasePoolProvider } from './config/database.js';
import { createAuthRouter } from './routes/auth.js';
import healthRouter from './routes/health.js';

export function createApp({ databasePoolProvider = createLazyDatabasePoolProvider(), authRouter } = {}) {
  const app = express();

  app.disable('x-powered-by');

  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.locals.databasePoolProvider = databasePoolProvider;

  const authenticationRouter = authRouter ?? createAuthRouter({
    getService: () => new AuthService({ pool: databasePoolProvider() }),
    getAccountService: () => new AccountService({ pool: databasePoolProvider() }),
    authenticate: createAuthenticationMiddleware({ getPool: databasePoolProvider }),
  });

  app.use('/health', healthRouter);
  app.use('/auth', authenticationRouter);

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    const status = err?.status === 413 ? 413 : (err instanceof SyntaxError && err.status === 400 ? 400 : 500);
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : (status === 400 ? 'INVALID_JSON' : 'INTERNAL_SERVER_ERROR');
    const message = status === 413
      ? 'The request body is too large.'
      : (status === 400 ? 'The request body must contain valid JSON.' : 'An unexpected error occurred');

    res.status(status).json({
      error: {
        code,
        message,
      },
    });
  });

  return app;
}

const app = createApp();

export default app;
