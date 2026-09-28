import {
  connectionFromEnvironment,
  confirmReplacement,
  nativeEnvironment,
  restoreArguments,
  verificationSql,
  connectDatabase,
  inspectDatabase,
  fingerprints,
  runPostgres,
} from './replace-production-db.js';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { hash, compare } from 'bcryptjs';

const environment = {
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USER: 'test',
  DB_PASSWORD: 'private-value',
  DB_NAME: 'development',
};

describe('explicit full database replacement', () => {
  it('separates a local source from a remote production destination', () => {
    expect(connectionFromEnvironment(environment, false).database).toBe(
      'development',
    );
    expect(() => connectionFromEnvironment(environment, true)).toThrow(
      'must not be localhost',
    );
    expect(() =>
      connectionFromEnvironment(
        { ...environment, DB_HOST: 'production.example' },
        false,
      ),
    ).toThrow('must be localhost');
    expect(() =>
      connectionFromEnvironment({ ...environment, DB_PASSWORD: '' }, false),
    ).toThrow('DB_PASSWORD');
  });

  it('requires exact destination identity and maintenance acknowledgements', () => {
    const target = connectionFromEnvironment(
      { ...environment, DB_HOST: 'production.example', DB_NAME: 'production' },
      true,
    );
    expect(() =>
      confirmReplacement(target, {
        database: 'development',
        host: target.host,
        maintenance: true,
        seedDisabled: true,
      }),
    ).toThrow('confirm-database');
    expect(() =>
      confirmReplacement(target, {
        database: target.database,
        host: target.host,
        maintenance: false,
        seedDisabled: true,
      }),
    ).toThrow('Stop application writes');
    expect(() =>
      confirmReplacement(target, {
        database: target.database,
        host: target.host,
        maintenance: true,
        seedDisabled: false,
      }),
    ).toThrow('disable automatic db:seed');
    expect(() =>
      confirmReplacement(target, {
        database: target.database,
        host: target.host,
        maintenance: true,
        seedDisabled: true,
      }),
    ).not.toThrow();
  });

  it('sends credentials through environment only and verifies production TLS', () => {
    const target = connectionFromEnvironment(
      { ...environment, DB_HOST: 'production.example' },
      true,
    );
    expect(nativeEnvironment(target)).toMatchObject({
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: 'system',
      PGPASSWORD: 'private-value',
    });
    const args = restoreArguments('source.sql', 'verify.sql');
    expect(args).toContain('--single-transaction');
    expect(args).toContain('--set=ON_ERROR_STOP=on');
    expect(args.indexOf('--command=DROP SCHEMA public CASCADE;')).toBeLessThan(
      args.indexOf('source.sql'),
    );
    expect(args.indexOf('source.sql')).toBeLessThan(args.indexOf('verify.sql'));
    expect(args.join(' ')).not.toContain('private-value');
  });

  it('checks contents as well as counts inside the restore transaction', () => {
    const sql = verificationSql([
      { name: 'users', rows: '2', digest: 'known-digest' },
    ]);
    expect(sql).toContain('public."users"');
    expect(sql).toContain("actual_rows <> '2'");
    expect(sql).toContain("actual_digest <> 'known-digest'");
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toContain('COMMIT');
  });
});

describe.skipIf(process.env.RUN_DATABASE_COPY_INTEGRATION !== '1')(
  'native PostgreSQL replacement integration',
  () => {
    it('restores all table contents and relations, invalidates sessions, preserves passwords and rolls back failed verification', async () => {
      const source = connectionFromEnvironment(
        parse(await readFile(new URL('../.env', import.meta.url))),
        false,
      );
      const administrator = await connectDatabase(source);
      const suffix = randomUUID().replaceAll('-', '');
      const sourceName = `gami_copy_source_${suffix}`;
      const destinationName = `gami_copy_target_${suffix}`;
      const directory = await mkdtemp(join(tmpdir(), 'gami-copy-test-'));
      const binaryDirectory =
        process.env.PG_BIN ?? 'C:\\Program Files\\PostgreSQL\\18\\bin';
      const log = join(directory, 'operation.log');
      const sourceConnection = { ...source, database: sourceName };
      const destinationConnection = { ...source, database: destinationName };
      let sourceClient: Awaited<ReturnType<typeof connectDatabase>> | undefined;
      let destinationClient:
        Awaited<ReturnType<typeof connectDatabase>> | undefined;
      try {
        await administrator.query(`CREATE DATABASE "${sourceName}"`);
        await administrator.query(`CREATE DATABASE "${destinationName}"`);
        sourceClient = await connectDatabase(sourceConnection);
        destinationClient = await connectDatabase(destinationConnection);
        const passwordHash = await hash('123', 4);
        await sourceClient.query(`
        CREATE TYPE user_status AS ENUM ('ACTIVE', 'SUSPENDED');
        CREATE TABLE users (id integer PRIMARY KEY, username text NOT NULL, password_hash text NOT NULL, status user_status NOT NULL);
        CREATE TABLE roles (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name text NOT NULL);
        CREATE TABLE user_roles (user_id integer REFERENCES users(id), role_id integer REFERENCES roles(id), PRIMARY KEY(user_id, role_id));
        CREATE TABLE auth_sessions (id integer PRIMARY KEY, user_id integer REFERENCES users(id));
        CREATE TABLE password_recovery_codes (id integer PRIMARY KEY, user_id integer REFERENCES users(id));
        CREATE TABLE additional_information (id integer PRIMARY KEY, payload jsonb, happened_at timestamptz);
      `);
        await sourceClient.query(
          "INSERT INTO users VALUES (1, 'local-account', $1, 'ACTIVE')",
          [passwordHash],
        );
        await sourceClient.query(
          'INSERT INTO roles(name) VALUES (\'SUPER_ADMIN\'); INSERT INTO user_roles VALUES (1,1); INSERT INTO auth_sessions VALUES (1,1); INSERT INTO password_recovery_codes VALUES (1,1); INSERT INTO additional_information VALUES (1, \'{"bank":"private-test","phone":"private-test"}\', \'2026-09-28T09:30:00-05:00\');',
        );
        await destinationClient.query(
          "CREATE TABLE production_only (id integer PRIMARY KEY, value text); INSERT INTO production_only VALUES (1, 'original destination');",
        );
        const previousDump = join(directory, 'previous.dump');
        const previousSql = join(directory, 'previous.sql');
        const sourceDump = join(directory, 'source.dump');
        const sourceSql = join(directory, 'source.sql');
        const verifyFile = join(directory, 'verify.sql');
        const dumpOptions = [
          '--format=custom',
          '--schema=public',
          '--quote-all-identifiers',
          '--no-owner',
          '--no-privileges',
          '--no-password',
        ];
        runPostgres(
          binaryDirectory,
          'pg_dump',
          [...dumpOptions, '--file', previousDump],
          destinationConnection,
          log,
        );
        runPostgres(
          binaryDirectory,
          'pg_restore',
          [
            '--no-owner',
            '--no-privileges',
            '--file',
            previousSql,
            previousDump,
          ],
          destinationConnection,
          log,
        );
        const original = await fingerprints(
          destinationClient,
          (await inspectDatabase(destinationClient)).tables,
          false,
        );
        await sourceClient.query(
          'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        const snapshot = (
          await sourceClient.query('SELECT pg_export_snapshot() AS snapshot')
        ).rows[0].snapshot as string;
        const expected = await fingerprints(
          sourceClient,
          (await inspectDatabase(sourceClient)).tables,
          true,
        );
        runPostgres(
          binaryDirectory,
          'pg_dump',
          [
            ...dumpOptions,
            `--snapshot=${snapshot}`,
            '--exclude-table-data=public.auth_sessions',
            '--exclude-table-data=public.password_recovery_codes',
            '--file',
            sourceDump,
          ],
          sourceConnection,
          log,
        );
        await sourceClient.query('COMMIT');
        runPostgres(
          binaryDirectory,
          'pg_restore',
          ['--no-owner', '--no-privileges', '--file', sourceSql, sourceDump],
          sourceConnection,
          log,
        );
        await writeFile(
          verifyFile,
          verificationSql(
            expected.map((table) =>
              table.name === 'users' ? { ...table, rows: '999' } : table,
            ),
          ),
        );
        expect(() =>
          runPostgres(
            binaryDirectory,
            'psql',
            restoreArguments(sourceSql, verifyFile),
            destinationConnection,
            log,
          ),
        ).toThrow('psql failed');
        expect(
          (await destinationClient.query('SELECT value FROM production_only'))
            .rows[0].value,
        ).toBe('original destination');
        await writeFile(verifyFile, verificationSql(expected));
        runPostgres(
          binaryDirectory,
          'psql',
          restoreArguments(sourceSql, verifyFile),
          destinationConnection,
          log,
        );
        expect(
          await fingerprints(
            destinationClient,
            (await inspectDatabase(destinationClient)).tables,
            false,
          ),
        ).toEqual(expected);
        expect(
          (
            await destinationClient.query(
              "SELECT to_regclass('public.production_only') AS table_name",
            )
          ).rows[0].table_name,
        ).toBeNull();
        expect(
          await compare(
            '123',
            (await destinationClient.query('SELECT password_hash FROM users'))
              .rows[0].password_hash,
          ),
        ).toBe(true);
        expect(
          (
            await destinationClient.query(
              'SELECT count(*)::int AS total FROM user_roles',
            )
          ).rows[0].total,
        ).toBe(1);
        expect(
          (
            await destinationClient.query(
              'SELECT count(*)::int AS total FROM auth_sessions',
            )
          ).rows[0].total,
        ).toBe(0);
        expect(
          (
            await destinationClient.query(
              'SELECT count(*)::int AS total FROM password_recovery_codes',
            )
          ).rows[0].total,
        ).toBe(0);
        expect(
          (
            await destinationClient.query(
              "INSERT INTO roles(name) VALUES ('SECOND_ROLE') RETURNING id",
            )
          ).rows[0].id,
        ).toBe(2);
        await writeFile(verifyFile, verificationSql(original));
        runPostgres(
          binaryDirectory,
          'psql',
          restoreArguments(previousSql, verifyFile),
          destinationConnection,
          log,
        );
        expect(
          (await destinationClient.query('SELECT value FROM production_only'))
            .rows[0].value,
        ).toBe('original destination');
        expect(
          (
            await sourceClient.query(
              'SELECT count(*)::int AS total FROM auth_sessions',
            )
          ).rows[0].total,
        ).toBe(1);
      } finally {
        if (sourceClient) await sourceClient.end();
        if (destinationClient) await destinationClient.end();
        await administrator.query(`DROP DATABASE IF EXISTS "${sourceName}"`);
        await administrator.query(
          `DROP DATABASE IF EXISTS "${destinationName}"`,
        );
        await administrator.end();
        await rm(directory, { recursive: true, force: true });
      }
    }, 120000);
  },
);
