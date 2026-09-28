import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import pg from 'pg';

export type DatabaseConnection = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  remote: boolean;
  caFile?: string;
};
export type TableFingerprint = { name: string; rows: string; digest: string };
const emptyTables = new Set(['auth_sessions', 'password_recovery_codes']);
const emptyDigest = 'd41d8cd98f00b204e9800998ecf8427e';
const backendRoot = fileURLToPath(new URL('../', import.meta.url));

export function connectionFromEnvironment(
  environment: Record<string, string>,
  remote: boolean,
): DatabaseConnection {
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
        `Missing or placeholder ${key} in the ${remote ? 'production' : 'development'} environment file.`,
      );
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(environment.DB_HOST);
  if (remote === local)
    throw new Error(
      remote
        ? 'Production destination must not be localhost.'
        : 'Development source must be localhost.',
    );
  const port = Number(environment.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid database port.');
  return {
    host: environment.DB_HOST,
    port,
    user: environment.DB_USER,
    password: environment.DB_PASSWORD,
    database: environment.DB_NAME,
    remote,
    caFile: environment.DB_SSL_CA_FILE || undefined,
  };
}

export function confirmReplacement(
  target: DatabaseConnection,
  options: {
    database?: string;
    host?: string;
    maintenance: boolean;
    seedDisabled: boolean;
  },
) {
  if (options.database !== target.database || options.host !== target.host)
    throw new Error(
      'Destructive replacement requires --confirm-database and --confirm-host matching the production destination.',
    );
  if (!options.maintenance || !options.seedDisabled)
    throw new Error(
      'Stop application writes and disable automatic db:seed first; acknowledge with --maintenance-confirmed --seed-disabled.',
    );
}

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function fingerprintQuery(table: string) {
  return `SELECT count(*)::text AS rows, md5(COALESCE(string_agg(md5(row_to_json(source_row)::text), '' ORDER BY md5(row_to_json(source_row)::text)), '')) AS digest FROM public.${identifier(table)} AS source_row`;
}

export function verificationSql(tables: TableFingerprint[]): string {
  const delimiter = `$verify_${randomUUID().replaceAll('-', '')}$`;
  const statements = tables.map(
    (table) =>
      `DO ${delimiter} DECLARE actual_rows text; actual_digest text; BEGIN SELECT rows, digest INTO actual_rows, actual_digest FROM (${fingerprintQuery(table.name)}) AS fingerprint; IF actual_rows <> ${literal(table.rows)} OR actual_digest <> ${literal(table.digest)} THEN RAISE EXCEPTION 'Restored table verification failed'; END IF; END ${delimiter};`,
  );
  return `SET TIME ZONE 'UTC';\n${statements.join('\n')}\n`;
}

export function nativeEnvironment(
  connection: DatabaseConnection,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PG')),
  );
  return {
    ...environment,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: connection.remote ? 'verify-full' : 'disable',
    ...(connection.remote
      ? { PGSSLROOTCERT: connection.caFile ?? 'system' }
      : {}),
    PGOPTIONS: '-c timezone=UTC',
  };
}

export function runPostgres(
  binaryDirectory: string,
  name: string,
  args: string[],
  connection: DatabaseConnection,
  logFile: string,
) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const executable = binaryDirectory
    ? join(binaryDirectory, `${name}${suffix}`)
    : name;
  const log = openSync(logFile, 'a', 0o600);
  try {
    const result = spawnSync(executable, args, {
      env: nativeEnvironment(connection),
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `${name} failed. No credentials printed; inspect the private operation log locally: ${logFile}`,
      );
  } finally {
    closeSync(log);
  }
}

export async function connectDatabase(connection: DatabaseConnection) {
  const { remote, caFile, ...configuration } = connection;
  const client = new pg.Client({
    ...configuration,
    connectionTimeoutMillis: 15000,
    ssl: remote
      ? {
          rejectUnauthorized: true,
          ...(caFile ? { ca: await readFile(caFile, 'utf8') } : {}),
        }
      : undefined,
  });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}

export async function inspectDatabase(client: pg.Client) {
  const schemas = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public', 'information_schema')",
  );
  const extensions = await client.query(
    "SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'",
  );
  const largeObjects = await client.query(
    'SELECT count(*)::int AS total FROM pg_largeobject_metadata',
  );
  if (schemas.rowCount || extensions.rowCount || largeObjects.rows[0].total)
    throw new Error(
      'Extra schemas, extensions or large objects require a dedicated migration review; automatic replacement refused.',
    );
  const version = Number(
    (await client.query('SHOW server_version_num')).rows[0].server_version_num,
  );
  const tables = (
    await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);
  return { version, tables };
}

export async function fingerprints(
  client: pg.Client,
  tables: string[],
  invalidateSessions: boolean,
): Promise<TableFingerprint[]> {
  const result: TableFingerprint[] = [];
  for (const name of tables) {
    if (invalidateSessions && emptyTables.has(name))
      result.push({ name, rows: '0', digest: emptyDigest });
    else
      result.push({
        name,
        ...(await client.query(fingerprintQuery(name))).rows[0],
      });
  }
  return result;
}

async function fileDigest(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export function restoreArguments(sqlFile: string, checkFile: string) {
  return [
    '--no-psqlrc',
    '--no-password',
    '--single-transaction',
    '--set=ON_ERROR_STOP=on',
    "--command=SET lock_timeout = '15s'; SET TIME ZONE 'UTC';",
    '--command=DROP SCHEMA public CASCADE;',
    '--file',
    sqlFile,
    '--file',
    checkFile,
  ];
}

async function main() {
  const { values } = parseArgs({
    options: {
      'source-env': { type: 'string', default: '.env' },
      'target-env': { type: 'string', default: '.env.onboarding.production' },
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
  const sourcePath = resolve(backendRoot, values['source-env']);
  const targetPath = resolve(backendRoot, values['target-env']);
  if (sourcePath === targetPath)
    throw new Error('Source and destination environment files must differ.');
  const source = connectionFromEnvironment(
    parse(await readFile(sourcePath)),
    false,
  );
  const target = connectionFromEnvironment(
    parse(await readFile(targetPath)),
    true,
  );
  if (values.apply)
    confirmReplacement(target, {
      database: values['confirm-database'],
      host: values['confirm-host'],
      maintenance: values['maintenance-confirmed'],
      seedDisabled: values['seed-disabled'],
    });
  const sourceClient = await connectDatabase(source);
  let targetClient: pg.Client | undefined;
  try {
    targetClient = await connectDatabase(target);
    const sourceInfo = await inspectDatabase(sourceClient);
    const targetInfo = await inspectDatabase(targetClient);
    if (targetInfo.version < Math.floor(sourceInfo.version / 10000) * 10000)
      throw new Error(
        'Production PostgreSQL must be the same major version or newer than development for this restore.',
      );
    for (const table of [
      'users',
      'roles',
      'user_roles',
      'store_members',
      '_prisma_migrations',
      ...emptyTables,
    ]) {
      if (!sourceInfo.tables.includes(table))
        throw new Error(`Required development table missing: ${table}`);
    }
    const active = await targetClient.query(
      "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'",
    );
    const publicProducts =
      sourceInfo.tables.includes('products') &&
      sourceInfo.tables.includes('stores')
        ? Number(
            (
              await sourceClient.query(
                "SELECT count(*) AS total FROM public.products product JOIN public.stores store ON store.id = product.store_id WHERE product.deleted_at IS NULL AND store.deleted_at IS NULL AND product.status = 'PUBLISHED' AND store.status = 'ACTIVE'",
              )
            ).rows[0].total,
          )
        : null;
    console.log(
      JSON.stringify({
        mode: values.apply ? 'replace' : 'plan-only',
        sourceTables: sourceInfo.tables.length,
        destinationTables: targetInfo.tables.length,
        destination: { host: target.host, database: target.database },
        destinationOtherConnections: active.rows[0].total,
        excludedData: [...emptyTables],
        sourcePublicProducts: publicProducts,
        notice:
          'States are copied exactly. Development preview visibility is not production publication. No seed or automatic publication will run.',
      }),
    );
    if (!values.apply) return;
    if (active.rows[0].total !== 0)
      throw new Error(
        'Production still has client connections. Stop the backend, jobs and database clients before replacement.',
      );

    const directory = join(
      backendRoot,
      '.db-backups',
      `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const logFile = join(directory, 'private-operation.log');
    const previousDump = join(directory, 'production-before.dump');
    const previousSql = join(directory, 'production-before.sql');
    const sourceDump = join(directory, 'development-sanitized.dump');
    const sourceSql = join(directory, 'development-sanitized.sql');
    const sourceCheck = join(directory, 'verify-development.sql');
    const previousCheck = join(directory, 'verify-production-before.sql');
    const dumpOptions = [
      '--format=custom',
      '--schema=public',
      '--quote-all-identifiers',
      '--no-owner',
      '--no-privileges',
      '--no-password',
      '--lock-wait-timeout=15s',
    ];

    await targetClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const targetSnapshot = (
      await targetClient.query('SELECT pg_export_snapshot() AS snapshot')
    ).rows[0].snapshot as string;
    const previous = await fingerprints(targetClient, targetInfo.tables, false);
    runPostgres(
      values['pg-bin'],
      'pg_dump',
      [...dumpOptions, `--snapshot=${targetSnapshot}`, '--file', previousDump],
      target,
      logFile,
    );
    runPostgres(
      values['pg-bin'],
      'pg_restore',
      ['--list', previousDump],
      target,
      logFile,
    );
    runPostgres(
      values['pg-bin'],
      'pg_restore',
      ['--no-owner', '--no-privileges', '--file', previousSql, previousDump],
      target,
      logFile,
    );
    await writeFile(previousCheck, verificationSql(previous), {
      flag: 'wx',
      mode: 0o600,
    });
    await targetClient.query('COMMIT');

    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sourceSnapshot = (
      await sourceClient.query('SELECT pg_export_snapshot() AS snapshot')
    ).rows[0].snapshot as string;
    const expected = await fingerprints(sourceClient, sourceInfo.tables, true);
    runPostgres(
      values['pg-bin'],
      'pg_dump',
      [
        ...dumpOptions,
        `--snapshot=${sourceSnapshot}`,
        ...[...emptyTables].map(
          (table) => `--exclude-table-data=public.${table}`,
        ),
        '--file',
        sourceDump,
      ],
      source,
      logFile,
    );
    await sourceClient.query('COMMIT');
    runPostgres(
      values['pg-bin'],
      'pg_restore',
      ['--no-owner', '--no-privileges', '--file', sourceSql, sourceDump],
      source,
      logFile,
    );
    await writeFile(sourceCheck, verificationSql(expected), {
      flag: 'wx',
      mode: 0o600,
    });
    const manifest = {
      createdAt: new Date().toISOString(),
      destination: { host: target.host, database: target.database },
      previous,
      expected,
      files: {
        'production-before.dump': await fileDigest(previousDump),
        'development-sanitized.dump': await fileDigest(sourceDump),
      },
    };
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    const finalConnections = await targetClient.query(
      "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'",
    );
    if (finalConnections.rows[0].total !== 0)
      throw new Error(
        'New production connections detected. Backups retained; replacement not started.',
      );
    runPostgres(
      values['pg-bin'],
      'psql',
      restoreArguments(sourceSql, sourceCheck),
      target,
      logFile,
    );
    console.log(
      JSON.stringify({
        replaced: true,
        verifiedTables: expected.length,
        sessionsInvalidated: true,
        privateBackupDirectory: directory,
        next: 'Restart the backend with automatic db:seed removed. Log in again. Do not commit or upload backups.',
      }),
    );
  } finally {
    await sourceClient.end();
    if (targetClient) await targetClient.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    if (error instanceof Error && error.name === 'Error')
      console.error(error.message);
    else
      console.error(
        'Database copy failed. No credentials printed. Check private configuration, TLS, PostgreSQL permissions and any private operation log.',
      );
    process.exitCode = 1;
  }
}
