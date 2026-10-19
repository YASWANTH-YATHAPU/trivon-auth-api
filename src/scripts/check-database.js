import 'dotenv/config';
import { createDatabasePool } from '../config/database.js';

let pool;

try {
  pool = createDatabasePool();
  const [rows] = await pool.query('SELECT 1 AS connected');

  if (rows[0]?.connected !== 1) {
    throw new Error('The database returned an unexpected result.');
  }

  console.log('Database connectivity verified (SELECT 1).');
} catch (error) {
  const safeConfigurationMessage = /^(Missing required database configuration:|Invalid database configuration:)/;

  if (safeConfigurationMessage.test(error.message)) {
    console.error(`Database check failed: ${error.message}`);
  } else {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    console.error(`Database check failed: unable to connect or execute SELECT 1${code}. Check MySQL availability and local settings.`);
  }

  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {
      console.error('Database check failed: unable to close the connection pool cleanly.');
      process.exitCode = 1;
    }
  }
}
