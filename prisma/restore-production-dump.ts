import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import pg from 'pg';

const backendRoot = fileURLToPath(new URL('../', import.meta.url));
const excludedTables = new Set(['auth_sessions', 'password_recovery_codes']);
const defaultDump = resolve(
  backendRoot,
  '..',
  'dump-postgres-202611051610.sql',
);
const psqlPrefix = String.fromCodePoint(92);
const copyTerminator = `${psqlPrefix}.`;

export type SanitizedDump = {
  sql: string;
  sourceDatabase: string;
  tables: string[];
  expectedRows: Record<string, number>;
  excludedRows: Record<string, number>;
};

function quotedName(value: string) {
  if (!/^[A-Za-z_]\w*$/.test(value))
    throw new Error('Unsupported SQL identifier in dump.');
  return `"${value.replaceAll('"', '""')}"`;
}

type DumpState = {
  selected: boolean;
  foundDatabase: boolean;
  inCopy: boolean;
  omitCopy: boolean;
  copyTable: string;
  copyRowCount: number;
  output: string[];
  tables: Set<string>;
  copyTables: Set<string>;
  expectedRows: Record<string, number>;
  excludedRows: Record<string, number>;
};

function connectionName(line: string) {
  const match = /^\\connect\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(line);
  return match ? (match[1] ?? match[2] ?? match[3]).replace(/;$/, '') : null;
}

function finishCopyLine(line: string, state: DumpState) {
  if (line === copyTerminator) {
    if (state.omitCopy)
      state.excludedRows[state.copyTable] = state.copyRowCount;
    else {
      state.output.push(line);
      state.expectedRows[state.copyTable] = state.copyRowCount;
    }
    state.inCopy = false;
    return;
  }
  state.copyRowCount++;
  if (!state.omitCopy) state.output.push(line);
}

function skippedCommand(line: string) {
  return (
    /^(?:CREATE ROLE|ALTER ROLE|CREATE DATABASE|ALTER DATABASE|SET SESSION AUTHORIZATION|SET ROLE|GRANT\b|REVOKE\b|ALTER DEFAULT PRIVILEGES\b)/i.test(
      line,
    ) ||
    /^ALTER .+\bOWNER TO\b/i.test(line) ||
    /^CREATE SCHEMA public\s*;/i.test(line)
  );
}

function selectedDatabaseLine(line: string, state: DumpState) {
  if (/^\\(?:restrict|unrestrict)\b/i.test(line)) return;
  if (line.startsWith(psqlPrefix))
    throw new Error('Unsupported psql command in selected database dump.');

  const createTable = /^CREATE TABLE public\.([A-Za-z_]\w*)\b/.exec(line);
  if (createTable) state.tables.add(createTable[1]);

  const copy = /^COPY public\.([A-Za-z_]\w*)\s+\([\s\S]*\) FROM stdin;$/.exec(
    line,
  );
  if (copy) {
    const table = copy[1];
    if (state.copyTables.has(table))
      throw new Error('Duplicate COPY section in dump.');
    state.copyTables.add(table);
    state.copyTable = table;
    state.omitCopy = excludedTables.has(table);
    state.inCopy = true;
    state.copyRowCount = 0;
    if (!state.omitCopy) state.output.push(line);
    return;
  }

  if (skippedCommand(line)) {
    if (!line.includes(';'))
      throw new Error(
        'Unsupported multiline ownership or role command in dump.',
      );
    return;
  }
  state.output.push(line);
}

function finishDump(state: DumpState, databaseName: string): SanitizedDump {
  if (state.inCopy) throw new Error('Unterminated COPY section in dump.');
  if (!state.foundDatabase)
    throw new Error(
      `Dump does not contain database section "${databaseName}".`,
    );
  if (
    !state.tables.size ||
    state.tables.size !== state.copyTables.size ||
    [...state.tables].some((table) => !state.copyTables.has(table))
  )
    throw new Error('Dump table definitions and COPY sections do not match.');
  for (const table of state.tables) quotedName(table);
  for (const table of excludedTables) state.expectedRows[table] = 0;
  return {
    sql: `${state.output.join('\n')}\n`,
    sourceDatabase: databaseName,
    tables: [...state.tables].sort((left, right) => left.localeCompare(right)),
    expectedRows: state.expectedRows,
    excludedRows: state.excludedRows,
  };
}

export function sanitizePgDumpAll(
  input: string,
  databaseName: string,
): SanitizedDump {
  const state: DumpState = {
    selected: false,
    foundDatabase: false,
    inCopy: false,
    omitCopy: false,
    copyTable: '',
    copyRowCount: 0,
    output: [],
    tables: new Set(),
    copyTables: new Set(),
    expectedRows: {},
    excludedRows: {},
  };
  for (const line of input.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (state.inCopy) {
      finishCopyLine(line, state);
      continue;
    }
    const name = connectionName(line);
    if (name !== null) {
      state.selected = name === databaseName;
      state.foundDatabase ||= state.selected;
      continue;
    }
    if (!state.selected) continue;
    if (line.trim()) selectedDatabaseLine(line, state);
    else state.output.push(line);
  }
  return finishDump(state, databaseName);
}

export function rowCountVerificationSql(expectedRows: Record<string, number>) {
  return (
    Object.entries(expectedRows)
      .map(([table, expected], index) => {
        const delimiter = `$restore_check_${index}_${randomUUID().replaceAll('-', '')}$`;
        return `DO ${delimiter} DECLARE actual bigint; BEGIN SELECT count(*) INTO actual FROM public.${quotedName(table)}; IF actual <> ${expected} THEN RAISE EXCEPTION 'Restored table row count mismatch'; END IF; END ${delimiter};`;
      })
      .join('\n') + '\n'
  );
}

type Target = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  caFile?: string;
};

function targetFromEnvironment(environment: Record<string, string>): Target {
  for (const key of [
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
  ]) {
    if (
      !environment[key] ||
      /YOUR_|replace-with|placeholder/i.test(environment[key])
    )
      throw new Error(
        `Missing or placeholder ${key} in the production environment file.`,
      );
  }
  if (['localhost', '127.0.0.1', '::1'].includes(environment.DB_HOST))
    throw new Error('Production destination must not be localhost.');
  const port = Number(environment.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid database port.');
  return {
    host: environment.DB_HOST,
    port,
    user: environment.DB_USER,
    password: environment.DB_PASSWORD,
    database: environment.DB_NAME,
    caFile: environment.DB_SSL_CA_FILE || undefined,
  };
}

async function connectTarget(target: Target) {
  const client = new pg.Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: 15000,
    ssl: {
      rejectUnauthorized: true,
      ...(target.caFile ? { ca: await readFile(target.caFile, 'utf8') } : {}),
    },
  });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}

function nativeEnvironment(target: Target): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('PG')),
    ),
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGUSER: target.user,
    PGPASSWORD: target.password,
    PGDATABASE: target.database,
    PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: 'require',
    PGOPTIONS: '-c timezone=UTC',
  };
}

function runNative(
  binaryDirectory: string,
  name: string,
  args: string[],
  target: Target,
  logFile: string,
) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const executable = binaryDirectory
    ? join(binaryDirectory, `${name}${suffix}`)
    : name;
  const log = openSync(logFile, 'a', 0o600);
  try {
    const result = spawnSync(executable, args, {
      env: nativeEnvironment(target),
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `${name} failed. No credentials printed; inspect the private operation log.`,
      );
  } finally {
    closeSync(log);
  }
}

async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function main() {
  const { values } = parseArgs({
    options: {
      'input-dump': { type: 'string', default: defaultDump },
      'target-env': { type: 'string', default: '.env.onboarding.production' },
      'source-database': { type: 'string', default: 'postgres' },
      'dump-only': { type: 'boolean', default: false },
      'pg-bin': {
        type: 'string',
        default:
          process.platform === 'win32'
            ? String.raw`C:\Program Files\PostgreSQL\18\bin`
            : '',
      },
      apply: { type: 'boolean', default: false },
      'confirm-database': { type: 'string' },
      'confirm-host': { type: 'string' },
      'maintenance-confirmed': { type: 'boolean', default: false },
      'seed-disabled': { type: 'boolean', default: false },
    },
  });
  const inputPath = resolve(backendRoot, values['input-dump']);
  const inputStat = await stat(inputPath);
  if (inputStat.size === 0 || inputStat.size > 1024 * 1024 * 1024)
    throw new Error('Dump file is empty or exceeds the 1 GiB safety limit.');
  const inputText = await readFile(inputPath, 'utf8');
  const dumpVersion = /^-- Dumped from database version ([^\r\n]+)/m.exec(
    inputText,
  )?.[1];
  const sanitized = sanitizePgDumpAll(inputText, values['source-database']);
  const dumpHash = createHash('sha256').update(inputText).digest('hex');
  if (values['dump-only']) {
    console.log(
      JSON.stringify({
        mode: 'dump-only',
        sha256: dumpHash,
        database: sanitized.sourceDatabase,
        postgresVersion: dumpVersion,
        tables: sanitized.tables.length,
        rows: {
          users: sanitized.expectedRows.users,
          stores: sanitized.expectedRows.stores,
          products: sanitized.expectedRows.products,
        },
        excludedRows: sanitized.excludedRows,
      }),
    );
    return;
  }
  const targetPath = resolve(backendRoot, values['target-env']);
  const target = targetFromEnvironment(parse(await readFile(targetPath)));
  if (
    values.apply &&
    (values['confirm-database'] !== target.database ||
      values['confirm-host'] !== target.host ||
      !values['maintenance-confirmed'] ||
      !values['seed-disabled'])
  )
    throw new Error(
      'Apply requires exact destination confirmations, a maintenance window, and disabled automatic seeding.',
    );

  const client = await connectTarget(target);
  let destination: {
    version: number;
    tables: string[];
    otherConnections: number;
  };
  try {
    const version = Number(
      (await client.query('SHOW server_version_num')).rows[0]
        .server_version_num,
    );
    if (version < 180000)
      throw new Error(
        'Destination PostgreSQL must be version 18 or newer for this dump.',
      );
    const tables = (
      await client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    const schemas = await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public', 'information_schema')",
    );
    const extensions = await client.query(
      "SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'",
    );
    const largeObjects = Number(
      (
        await client.query(
          'SELECT count(*)::int AS total FROM pg_largeobject_metadata',
        )
      ).rows[0].total,
    );
    if (schemas.rowCount || extensions.rowCount || largeObjects)
      throw new Error(
        'Destination has extra schemas, extensions or large objects; automatic restore refused.',
      );
    const otherConnections = Number(
      (
        await client.query(
          "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
        )
      ).rows[0].total,
    );
    destination = { version, tables, otherConnections };
  } finally {
    await client.end();
  }

  console.log(
    JSON.stringify({
      mode: values.apply ? 'restore' : 'plan-only',
      dump: {
        file: inputPath,
        sha256: dumpHash,
        database: sanitized.sourceDatabase,
        postgresVersion: dumpVersion,
        tables: sanitized.tables.length,
        rows: {
          users: sanitized.expectedRows.users,
          stores: sanitized.expectedRows.stores,
          products: sanitized.expectedRows.products,
        },
        excludedRows: sanitized.excludedRows,
      },
      destination: {
        host: target.host,
        database: target.database,
        postgresVersion: destination.version,
        tables: destination.tables.length,
        otherConnections: destination.otherConnections,
      },
      tls: 'Render external connection uses encrypted sslmode=require for native pg tools; Node preflight verifies TLS certificate.',
      notice:
        'Plan only does not create a backup or modify the database. Apply backs up and verifies destination before a single-transaction restore.',
    }),
  );
  if (!values.apply) return;
  if (destination.otherConnections !== 0)
    throw new Error(
      'Stop the backend and all other destination clients before restoring.',
    );

  const directory = join(
    backendRoot,
    '.db-backups',
    `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logFile = join(directory, 'private-operation.log');
  const backupFile = join(directory, 'production-before.dump');
  const sanitizedFile = join(directory, 'source-sanitized.sql');
  const verifyFile = join(directory, 'verify-restored.sql');
  const manifestFile = join(directory, 'manifest.json');
  const dumpOptions = [
    '--format=custom',
    '--schema=public',
    '--quote-all-identifiers',
    '--no-owner',
    '--no-privileges',
    '--no-password',
    '--lock-wait-timeout=15s',
    '--file',
    backupFile,
  ];

  runNative(values['pg-bin'], 'pg_dump', dumpOptions, target, logFile);
  if ((await stat(backupFile)).size === 0)
    throw new Error(
      `Destination backup is empty. Private directory: ${directory}`,
    );
  runNative(
    values['pg-bin'],
    'pg_restore',
    ['--list', backupFile],
    target,
    logFile,
  );
  await writeFile(sanitizedFile, sanitized.sql, { flag: 'wx', mode: 0o600 });
  await writeFile(verifyFile, rowCountVerificationSql(sanitized.expectedRows), {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(
    manifestFile,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        inputSha256: dumpHash,
        sourceDatabase: sanitized.sourceDatabase,
        destination: { host: target.host, database: target.database },
        tables: sanitized.tables.length,
        expectedRows: sanitized.expectedRows,
        excludedRows: sanitized.excludedRows,
        backupSha256: await sha256(backupFile),
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );

  const checkClient = await connectTarget(target);
  let otherConnections: number;
  try {
    otherConnections = Number(
      (
        await checkClient.query(
          "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
        )
      ).rows[0].total,
    );
  } finally {
    await checkClient.end();
  }
  if (otherConnections !== 0)
    throw new Error(
      `Backup retained at ${directory}; new destination connections detected, restore not started.`,
    );

  runNative(
    values['pg-bin'],
    'psql',
    [
      '--no-psqlrc',
      '--no-password',
      '--single-transaction',
      '--set=ON_ERROR_STOP=on',
      "--command=SET lock_timeout = '15s'; SET TIME ZONE 'UTC'; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
      '--file',
      sanitizedFile,
      '--file',
      verifyFile,
    ],
    target,
    logFile,
  );
  console.log(
    JSON.stringify({
      restored: true,
      verifiedTables: sanitized.tables.length,
      invalidatedSessionRows: sanitized.excludedRows.auth_sessions ?? 0,
      invalidatedRecoveryRows:
        sanitized.excludedRows.password_recovery_codes ?? 0,
      privateBackupDirectory: directory,
      next: 'Keep automatic db:seed disabled, restart the backend, and validate login and catalog state.',
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Unknown restore error.',
    );
    process.exitCode = 1;
  }
}
