import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { UsersModule } from './users/users.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { AdminInformationModule } from './admin-information/admin-information.module.js';
import { StoresModule } from './stores/stores.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    UsersModule,
    CatalogModule,
    AdminInformationModule,
    StoresModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
