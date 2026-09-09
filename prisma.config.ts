import 'dotenv/config';
import { defineConfig } from 'prisma/config';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return encodeURIComponent(value);
}

const databaseUrl = `postgresql://${required('DB_USER')}:${required('DB_PASSWORD')}@${required('DB_HOST')}:${required('DB_PORT')}/${required('DB_NAME')}?schema=public`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
