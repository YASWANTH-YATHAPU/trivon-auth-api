import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabasePool } from '../src/config/database.js';

const validConfig = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'test_user',
  DB_PASSWORD: 'test_password',
  DB_NAME: 'trivon_test',
};

test('database pool factory reports missing required configuration', () => {
  assert.throws(
    () => createDatabasePool({}),
    /Missing required database configuration: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME/,
  );
});

test('database pool factory creates and closes a pool without connecting to MySQL', async () => {
  const pool = createDatabasePool(validConfig);

  try {
    assert.equal(typeof pool.query, 'function');
    assert.equal(typeof pool.end, 'function');
  } finally {
    await pool.end();
  }
});

test('database pool factory rejects an invalid port', () => {
  assert.throws(
    () => createDatabasePool({ ...validConfig, DB_PORT: '3306abc' }),
    /DB_PORT must be an integer from 1 to 65535/,
  );
});
