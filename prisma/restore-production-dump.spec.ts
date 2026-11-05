import {
  rowCountVerificationSql,
  sanitizePgDumpAll,
} from './restore-production-dump.js';

const fixture = String.raw`\restrict first
-- PostgreSQL cluster dump
\connect template1
CREATE ROLE postgres;
CREATE DATABASE gami;
\connect gami
CREATE TABLE public.unrelated (id integer);
COPY public.unrelated (id) FROM stdin;
99
\.
\connect postgres
CREATE SCHEMA public;
CREATE TABLE public.users (id integer, note text);
COPY public.users (id, note) FROM stdin;
1\tuser-one
2\tuser-two
\.
CREATE TABLE public.auth_sessions (id integer, secret text);
COPY public.auth_sessions (id, secret) FROM stdin;
1\ttoken-secret-must-not-leak
\.
CREATE TABLE public.password_recovery_codes (id integer);
COPY public.password_recovery_codes (id) FROM stdin;
1
\.
ALTER TABLE public.users OWNER TO postgres;
COMMENT ON TABLE public.users IS 'keep comment';
\unrestrict last`;

describe('production SQL dump restore', () => {
  it('selects only the requested database, removes cluster ownership and excludes auth rows', () => {
    const result = sanitizePgDumpAll(fixture, 'postgres');
    expect(result.tables).toEqual([
      'auth_sessions',
      'password_recovery_codes',
      'users',
    ]);
    expect(result.expectedRows).toEqual({
      auth_sessions: 0,
      password_recovery_codes: 0,
      users: 2,
    });
    expect(result.excludedRows).toEqual({
      auth_sessions: 1,
      password_recovery_codes: 1,
    });
    expect(result.sql).toContain('user-one');
    expect(result.sql).toContain(
      "COMMENT ON TABLE public.users IS 'keep comment';",
    );
    expect(result.sql).not.toContain('token-secret-must-not-leak');
    expect(result.sql).not.toContain('CREATE DATABASE');
    expect(result.sql).not.toContain('CREATE ROLE');
    expect(result.sql).not.toContain('OWNER TO');
    expect(result.sql).not.toContain('unrelated');
  });

  it('generates transactional verification for included and deliberately empty tables', () => {
    const sql = rowCountVerificationSql({ users: 2, auth_sessions: 0 });
    expect(sql).toContain('FROM public."users"');
    expect(sql).toContain('actual <> 2');
    expect(sql).toContain('FROM public."auth_sessions"');
    expect(sql).toContain('actual <> 0');
  });

  it('fails closed on missing source database, mismatched data sections and unknown psql commands', () => {
    expect(() => sanitizePgDumpAll(fixture, 'missing')).toThrow(
      'does not contain database',
    );
    expect(() =>
      sanitizePgDumpAll(
        fixture.replace(
          'COPY public.users (id, note) FROM stdin;',
          'COPY public.unknown (id) FROM stdin;',
        ),
        'postgres',
      ),
    ).toThrow('do not match');
    expect(() =>
      sanitizePgDumpAll(
        fixture.replace('CREATE SCHEMA public;', '\\! whoami'),
        'postgres',
      ),
    ).toThrow('Unsupported psql command');
  });

  it.skipIf(process.env.RUN_RESTORE_DUMP_LOCAL_INTEGRATION !== '1')(
    'restores the real dump in an isolated loopback database and verifies every table count',
    async () => {
      const { readFileSync } = await import('node:fs');
      const { randomUUID } = await import('node:crypto');
      const { spawnSync } = await import('node:child_process');
      const { parse } = await import('dotenv');
      const { Client } = await import('pg');
      const environment = parse(
        readFileSync(new URL('../.env', import.meta.url)),
      );
      expect(['localhost', '127.0.0.1', '::1']).toContain(environment.DB_HOST);
      const dump = sanitizePgDumpAll(
        readFileSync(
          new URL('../../dump-postgres-202611051610.sql', import.meta.url),
          'utf8',
        ),
        'postgres',
      );
      const database = `gami_restore_validate_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const admin = new Client({
        host: environment.DB_HOST,
        port: Number(environment.DB_PORT),
        user: environment.DB_USER,
        password: environment.DB_PASSWORD,
        database: 'postgres',
      });
      let created = false;
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${database}"`);
        created = true;
        const nativeEnvironment = {
          ...process.env,
          PGHOST: environment.DB_HOST,
          PGPORT: String(environment.DB_PORT),
          PGUSER: environment.DB_USER,
          PGPASSWORD: environment.DB_PASSWORD,
          PGDATABASE: database,
          PGSSLMODE: 'disable',
          PGOPTIONS: '-c timezone=UTC',
        };
        const result = spawnSync(
          String.raw`C:\Program Files\PostgreSQL\18\bin\psql.exe`,
          [
            '--no-psqlrc',
            '--no-password',
            '--single-transaction',
            '--set=ON_ERROR_STOP=on',
            "--command=SET lock_timeout='15s'; SET TIME ZONE 'UTC'; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            '--file',
            '-',
          ],
          {
            env: nativeEnvironment,
            input: `${dump.sql}\n${rowCountVerificationSql(dump.expectedRows)}`,
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        const restored = new Client({
          host: environment.DB_HOST,
          port: Number(environment.DB_PORT),
          user: environment.DB_USER,
          password: environment.DB_PASSWORD,
          database,
        });
        try {
          await restored.connect();
          for (const [table, expected] of Object.entries(dump.expectedRows)) {
            const actual = Number(
              (
                await restored.query(
                  `SELECT count(*)::int AS total FROM public."${table}"`,
                )
              ).rows[0].total,
            );
            expect(actual, table).toBe(expected);
          }
        } finally {
          await restored.end();
        }
      } finally {
        if (created)
          await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        await admin.end();
      }
    },
    90000,
  );
});
