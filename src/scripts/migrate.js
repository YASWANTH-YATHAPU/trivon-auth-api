import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from '../config/database.js';
import {
  assertKnownAppliedMigrations,
  assertNoMigrationConflicts,
  assertNoTargetTableConflicts,
  assertTargetDatabase,
  listCreatedTables,
  splitSqlStatements,
} from '../db/migration-utils.js';

const migrationDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const migrationTable = 'schema_migrations';

async function loadMigrations() {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();

  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
    return {
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      tables: listCreatedTables(sql),
    };
  }));
}

async function tableNames(connection) {
  const [rows] = await connection.query(
    'SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  return new Set(rows.map((row) => row.tableName));
}

async function verifySelectedDatabase(connection) {
  const [rows] = await connection.query('SELECT DATABASE() AS selectedDatabase');
  const selectedDatabase = rows[0]?.selectedDatabase;
  assertTargetDatabase(process.env.DB_NAME, selectedDatabase);
  console.log(`Selected database: ${selectedDatabase}`);
}

async function hasMigrationTable(connection, tables) {
  return tables.has(migrationTable);
}

async function createMigrationTable(connection) {
  await connection.query(`
    CREATE TABLE ${migrationTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      migration_name VARCHAR(190) NOT NULL,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_schema_migrations_name (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

async function existingMigrations(connection, migrationTableExists) {
  if (!migrationTableExists) return new Map();
  const [rows] = await connection.query(
    `SELECT migration_name AS migrationName, checksum FROM ${migrationTable}`,
  );
  return new Map(rows.map((row) => [row.migrationName, row.checksum]));
}

function ensureMigrationConfirmation() {
  if (process.env.ALLOW_SCHEMA_MIGRATIONS !== 'true') {
    throw new Error('Migration execution requires ALLOW_SCHEMA_MIGRATIONS=true after confirming DB_NAME is the intended development database.');
  }
}

async function printStatus(connection, migrations, tables) {
  const applied = await existingMigrations(connection, await hasMigrationTable(connection, tables));
  assertKnownAppliedMigrations(applied, migrations);
  for (const migration of migrations) {
    const recordedChecksum = applied.get(migration.name);
    if (recordedChecksum && recordedChecksum !== migration.checksum) {
      throw new Error(`Recorded migration checksum does not match ${migration.name}; manual review is required.`);
    }
    console.log(`${migration.name}: ${recordedChecksum ? 'applied' : 'pending'}`);
  }

  if (!tables.has(migrationTable)) {
    const trackedTargets = migrations.flatMap((migration) => migration.tables).filter((name) => tables.has(name));
    if (trackedTargets.length > 0) {
      console.log(`Untracked application tables detected (${trackedTargets.length}); migration execution will stop for manual review.`);
    }
  }
}

async function runMigrations(connection, migrations, tables) {
  ensureMigrationConfirmation();

  const trackingTableExists = await hasMigrationTable(connection, tables);
  if (!trackingTableExists) {
    assertNoTargetTableConflicts(migrations, tables);
    await createMigrationTable(connection);
    tables.add(migrationTable);
  }

  const applied = await existingMigrations(connection, true);
  assertKnownAppliedMigrations(applied, migrations);
  for (const migration of migrations) {
    const recordedChecksum = applied.get(migration.name);
    if (recordedChecksum) {
      if (recordedChecksum !== migration.checksum) {
        throw new Error(`Recorded migration checksum does not match ${migration.name}; no later migration was run.`);
      }
      continue;
    }

    const currentTables = await tableNames(connection);
    assertNoMigrationConflicts(migration, currentTables);

    for (const statement of splitSqlStatements(migration.sql)) {
      await connection.query(statement);
    }
    await connection.query(
      `INSERT INTO ${migrationTable} (migration_name, checksum) VALUES (?, ?)`,
      [migration.name, migration.checksum],
    );
    console.log(`Applied ${migration.name}.`);
  }
}

const command = process.argv[2];
if (!['up', 'status'].includes(command)) {
  console.error('Usage: node src/scripts/migrate.js <up|status>');
  process.exitCode = 2;
} else {
  let pool;
  try {
    const migrations = await loadMigrations();
    if (migrations.length === 0) throw new Error('No migration files were found.');
    pool = createDatabasePool();
    const connection = await pool.getConnection();
    try {
      await verifySelectedDatabase(connection);
      const tables = await tableNames(connection);
      if (command === 'status') await printStatus(connection, migrations, tables);
      else await runMigrations(connection, migrations, tables);
    } finally {
      connection.release();
    }
  } catch (error) {
    const safeConfigurationMessage = /^(Missing required database configuration:|Invalid database configuration:|Connected database does not match DB_NAME|Migration execution requires |Existing application tables |Migration \w+ would encounter |Recorded migration checksum|Database contains migrations missing|No migration files)/;
    if (safeConfigurationMessage.test(error.message)) {
      console.error(`Migration command failed: ${error.message}`);
    } else {
      const code = typeof error.code === 'string' ? ` (${error.code})` : '';
      console.error(`Migration command failed: unable to read or update the configured database${code}. No destructive SQL is issued by this runner.`);
    }
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        console.error('Migration command failed: unable to close the connection pool cleanly.');
        process.exitCode = 1;
      }
    }
  }
}
