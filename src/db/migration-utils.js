export function splitSqlStatements(sql) {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function listCreatedTables(sql) {
  return [...sql.matchAll(/CREATE\s+TABLE\s+([a-zA-Z0-9_]+)/gi)].map((match) => match[1]);
}

export function assertNoTargetTableConflicts(migrations, existingTables) {
  const conflicts = migrations.flatMap((migration) => migration.tables)
    .filter((name) => existingTables.has(name));
  if (conflicts.length > 0) {
    throw new Error(`Existing application tables are not tracked by migrations (${[...new Set(conflicts)].join(', ')}); no changes were made. Review the target database manually.`);
  }
}

export function assertNoMigrationConflicts(migration, existingTables) {
  const conflicts = migration.tables.filter((name) => existingTables.has(name));
  if (conflicts.length > 0) {
    throw new Error(`Migration ${migration.name} would encounter existing tables (${conflicts.join(', ')}); no statements were run for this migration. Review the target database manually.`);
  }
}

export function assertKnownAppliedMigrations(applied, migrations) {
  const known = new Set(migrations.map((migration) => migration.name));
  const unknown = [...applied.keys()].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(`Database contains migrations missing from this checkout (${unknown.join(', ')}); no migration was run. Restore the migration files or review the database manually.`);
  }
}

export function assertTargetDatabase(expectedDatabase, selectedDatabase) {
  const expected = typeof expectedDatabase === 'string' ? expectedDatabase.trim() : '';
  const selected = typeof selectedDatabase === 'string' ? selectedDatabase.trim() : '';
  if (!expected || !selected || expected !== selected) {
    throw new Error('Connected database does not match DB_NAME; no schema changes were made.');
  }
}
