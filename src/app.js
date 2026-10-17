import express from 'express';
import helmet from 'helmet';
import healthRouter from './routes/health.js';

const app = express();

app.disable('x-powered-by');

app.use(helmet());
app.use(express.json({ limit: '10kb' }));

// Health-check API
app.use('/health', healthRouter);

// Handle unknown routes
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
});

// Centralized error handler
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
});

export default app;