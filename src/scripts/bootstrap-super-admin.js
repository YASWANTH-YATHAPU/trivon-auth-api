import 'dotenv/config';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createDatabasePool } from '../config/database.js';
import { passwordHasher } from '../auth/passwords.js';
import { assertTargetDatabase } from '../db/migration-utils.js';

const lockName = 'trivon-auth:first-super-admin';

async function ask(question) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

function askHidden(question) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this command from an interactive terminal so the password can be entered without echo.');
  }

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Bootstrap cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ' && character !== '\u007f') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function createInitialSuperAdmin() {
  const pool = createDatabasePool();
  let connection;
  let hasLock = false;

  try {
    connection = await pool.getConnection();
    const [databaseRows] = await connection.query('SELECT DATABASE() AS selectedDatabase');
    assertTargetDatabase(process.env.DB_NAME, databaseRows[0]?.selectedDatabase);
    stdout.write(`Connected database: ${databaseRows[0].selectedDatabase}\n`);
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error('Could not obtain the bootstrap lock. Retry after checking other bootstrap processes.');
    hasLock = true;

    const [countRows] = await connection.query('SELECT COUNT(*) AS accountCount FROM super_admins');
    if (Number(countRows[0]?.accountCount) !== 0) {
      throw new Error('A Super Admin already exists; initial bootstrap is disabled.');
    }

    const name = await ask('Super Admin name: ');
    const email = (await ask('Super Admin email: ')).toLowerCase();
    if (name.length < 1 || name.length > 150) throw new Error('Name must contain between 1 and 150 characters.');
    if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address of at most 255 characters.');

    const password = await askHidden('Password (12-72 UTF-8 bytes): ');
    const confirmation = await askHidden('Confirm password: ');
    if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error('Password must contain between 12 and 72 UTF-8 bytes.');
    }
    if (password !== confirmation) throw new Error('The passwords did not match.');

    const passwordHash = await passwordHasher.hash(password);
    const [result] = await connection.query(
      'INSERT INTO super_admins (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, passwordHash],
    );
    stdout.write(`Created the initial Super Admin account (ID ${result.insertId}).\n`);
  } finally {
    if (connection && hasLock) {
      try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* pool close releases advisory locks */ }
    }
    connection?.release();
    await pool.end();
  }
}

try {
  await createInitialSuperAdmin();
} catch (error) {
  if (error.message.startsWith('Missing required database configuration:')
    || error.message.startsWith('Invalid database configuration:')
    || error.message.startsWith('Run this command')
    || error.message.startsWith('A Super Admin already exists')
    || error.message.startsWith('Name must')
    || error.message.startsWith('Enter a valid email')
    || error.message.startsWith('Password must')
    || error.message.startsWith('The passwords')
    || error.message.startsWith('Bootstrap cancelled')
    || error.message.startsWith('Could not obtain')) {
    console.error(`Super Admin bootstrap failed: ${error.message}`);
  } else {
    console.error('Super Admin bootstrap failed: unable to access the configured database. Check local settings and schema state.');
  }
  process.exitCode = 1;
}
