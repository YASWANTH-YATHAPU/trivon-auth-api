import { createPool } from 'mysql2/promise';

const requiredVariables = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

function readDatabaseConfig(env) {
  const missing = requiredVariables.filter((name) => (
    env[name] === undefined
    || env[name] === null
    || (name !== 'DB_PASSWORD' && String(env[name]).trim() === '')
  ));

  if (missing.length > 0) {
    throw new Error(`Missing required database configuration: ${missing.join(', ')}`);
  }

  const portText = String(env.DB_PORT).trim();
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid database configuration: DB_PORT must be an integer from 1 to 65535.');
  }

  return {
    host: String(env.DB_HOST).trim(),
    port,
    user: String(env.DB_USER).trim(),
    password: String(env.DB_PASSWORD),
    database: String(env.DB_NAME).trim(),
  };
}

/** Create a MySQL pool on demand; importing this module does not open a connection. */
export function createDatabasePool(env = process.env) {
  const config = readDatabaseConfig(env);

  return createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 0,
    connectTimeout: 10_000,
  });
}
