import { hash } from 'bcryptjs';
import { parse } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { Client } from 'pg';

const backendRoot = fileURLToPath(new URL('../', import.meta.url));

export function validatePasswordPair(password: string, confirmation: string) {
  if (password.length < 12)
    throw new Error('La contraseña debe tener al menos 12 caracteres.');
  if (Buffer.byteLength(password, 'utf8') > 72)
    throw new Error('La contraseña no puede superar 72 bytes UTF-8.');
  if (password !== confirmation)
    throw new Error('Las contraseñas no coinciden.');
}

export function validateResetTarget(target: {
  username: string;
  status: string;
  isSuperAdmin: boolean;
}) {
  if (target.username.toLowerCase() !== 'alexander')
    throw new Error('El reset está limitado a la cuenta alexander.');
  if (target.status !== 'ACTIVE')
    throw new Error(
      'La cuenta alexander no está activa; el reset fue cancelado.',
    );
  if (!target.isSuperAdmin)
    throw new Error(
      'La cuenta alexander no tiene el rol SUPER_ADMIN; el reset fue cancelado.',
    );
}

export function promptHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function')
    throw new Error('Ejecuta este reset en una terminal interactiva local.');
  emitKeypressEvents(input);
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolvePrompt, rejectPrompt) => {
    let value = '';
    const cleanup = () => {
      input.off('keypress', onKeypress);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };
    const onKeypress = (
      character: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        rejectPrompt(new Error('Operación cancelada.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolvePrompt(value);
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
      }
    };
    input.on('keypress', onKeypress);
  });
}

async function main() {
  const environmentPath = resolve(
    backendRoot,
    process.env.TARGET_ENV_FILE ?? '.env.onboarding.production',
  );
  const environment = parse(await readFile(environmentPath));
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  for (const name of required) {
    if (!environment[name])
      throw new Error(`Falta ${name} en el archivo de entorno privado.`);
  }
  if (['localhost', '127.0.0.1', '::1'].includes(environment.DB_HOST))
    throw new Error('Este comando es solo para producción remota.');

  const client = new Client({
    host: environment.DB_HOST,
    port: Number(environment.DB_PORT),
    user: environment.DB_USER,
    password: environment.DB_PASSWORD,
    database: environment.DB_NAME,
    connectionTimeoutMillis: 15000,
    ssl: {
      rejectUnauthorized: true,
      ...(environment.DB_SSL_CA_FILE
        ? { ca: await readFile(environment.DB_SSL_CA_FILE, 'utf8') }
        : {}),
    },
  });

  const password = await promptHidden('Nueva contraseña (entrada oculta): ');
  const confirmation = await promptHidden('Confirma la contraseña: ');
  validatePasswordPair(password, confirmation);
  const passwordHash = await hash(password, 12);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'gami:alexander-superadmin-recovery',
    ]);
    const userResult = await client.query<{
      id: string;
      username: string;
      status: string;
    }>(
      `SELECT id, username, status FROM users
       WHERE lower(username) = 'alexander' AND deleted_at IS NULL
       FOR UPDATE`,
    );
    if (userResult.rowCount !== 1)
      throw new Error(
        'No existe exactamente una cuenta alexander activa en la base.',
      );
    const user = userResult.rows[0];
    const roleResult = await client.query<{ is_super_admin: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND r.code = 'SUPER_ADMIN'
       ) AS is_super_admin`,
      [user.id],
    );
    validateResetTarget({
      username: user.username,
      status: user.status,
      isSuperAdmin: roleResult.rows[0].is_super_admin,
    });

    await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = true,
       password_changed_at = NULL, updated_at = now() WHERE id = $1`,
      [user.id, passwordHash],
    );
    const sessions = await client.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'PASSWORD_RESET'
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    const recoveryCodes = await client.query(
      `UPDATE password_recovery_codes SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    await client.query(
      `INSERT INTO audit_log
       (actor_user_id, entity_type, entity_id, action, channel, reason, metadata)
       VALUES (NULL, 'user', $1, 'USER_PASSWORD_RESET', 'SYSTEM', $2, $3::jsonb)`,
      [
        user.id,
        'Recuperación local solicitada por el propietario tras restaurar la base.',
        JSON.stringify({
          source: 'LOCAL_SECURE_RECOVERY',
          mustChangePassword: true,
          invalidatedSessions: sessions.rowCount ?? 0,
          invalidatedRecoveryCodes: recoveryCodes.rowCount ?? 0,
        }),
      ],
    );
    await client.query('COMMIT');
    console.log(
      JSON.stringify({
        reset: true,
        username: user.username,
        mustChangePassword: true,
        invalidatedSessions: sessions.rowCount ?? 0,
        invalidatedRecoveryCodes: recoveryCodes.rowCount ?? 0,
      }),
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Falló el reset seguro.',
    );
    process.exitCode = 1;
  }
}
