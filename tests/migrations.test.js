import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertKnownAppliedMigrations,
  assertNoMigrationConflicts,
  assertNoTargetTableConflicts,
  assertTargetDatabase,
  listCreatedTables,
  splitSqlStatements,
} from '../src/db/migration-utils.js';

const migrationName = '001_initial_schema.sql';

test('migration SQL utilities split statements and list tables', () => {
  const sql = '-- first table\nCREATE TABLE accounts (id BIGINT);\n-- second table\nCREATE TABLE sessions (id BIGINT);';
  assert.deepEqual(splitSqlStatements(sql), [
    'CREATE TABLE accounts (id BIGINT)',
    'CREATE TABLE sessions (id BIGINT)',
  ]);
  assert.deepEqual(listCreatedTables(sql), ['accounts', 'sessions']);
});

test('migration preflight stops before touching existing untracked tables', () => {
  const migration = { name: migrationName, tables: ['accounts', 'sessions'] };
  assert.throws(() => assertNoTargetTableConflicts([migration], new Set(['accounts'])), /no changes were made/);
  assert.throws(() => assertNoMigrationConflicts(migration, new Set(['sessions'])), /no statements were run/);
  assert.doesNotThrow(() => assertNoTargetTableConflicts([migration], new Set(['schema_migrations'])));
});

test('migration runner rejects database migrations missing from the checkout', () => {
  assert.throws(
    () => assertKnownAppliedMigrations(new Map([['000_retired.sql', 'checksum']]), [{ name: migrationName }]),
    /missing from this checkout/,
  );
  assert.doesNotThrow(() => assertKnownAppliedMigrations(new Map([[migrationName, 'checksum']]), [{ name: migrationName }]));
});

test('migration runner verifies the selected database before DDL', () => {
  assert.doesNotThrow(() => assertTargetDatabase('trivon_auth_dev', 'trivon_auth_dev'));
  assert.throws(() => assertTargetDatabase('trivon_auth_dev', 'trivon_auth'), /does not match DB_NAME/);
  assert.throws(() => assertTargetDatabase('trivon_auth_dev', null), /does not match DB_NAME/);
});

test('initial migration preserves the proposed table set and contains no destructive DDL', async () => {
  const sql = await readFile(new URL('../migrations/001_initial_schema.sql', import.meta.url), 'utf8');
  const tables = listCreatedTables(sql).sort();
  assert.deepEqual(tables, [
    'accountants', 'admins', 'customer_care', 'global_account_roles', 'jwt_tokens',
    'permissions', 'refresh_tokens', 'role_permissions', 'roles', 'seller_user_roles',
    'seller_users', 'seller_verifications', 'sellers', 'super_admins', 'user_addresses',
  ]);
  assert.equal(/\bDROP\s+TABLE\b/i.test(sql), false);
  assert.match(sql, /UNIQUE KEY uq_seller_users_seller_email \(seller_id, email\)/);
  assert.match(sql, /UNIQUE KEY uq_seller_verifications_seller \(seller_id\)/);
});
