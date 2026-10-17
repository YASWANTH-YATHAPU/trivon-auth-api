import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import app from '../src/app.js';

async function startTestServer() {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

test('GET /health returns the healthy status', async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await server.close();
  }
});

test('unknown routes return the application 404 error response', async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/unknown-route`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    });
  } finally {
    await server.close();
  }
});
