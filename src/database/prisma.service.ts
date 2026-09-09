import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const user = encodeURIComponent(config.getOrThrow<string>('DB_USER'));
    const password = encodeURIComponent(
      config.getOrThrow<string>('DB_PASSWORD'),
    );
    const host = config.getOrThrow<string>('DB_HOST');
    const port = config.getOrThrow<string>('DB_PORT');
    const database = encodeURIComponent(config.getOrThrow<string>('DB_NAME'));
    const connectionString = `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`;
    const adapter = new PrismaPg({ connectionString });

    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
