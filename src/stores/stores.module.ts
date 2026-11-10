import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StoresController } from './stores.controller.js';
import { StoresService } from './stores.service.js';
import { UsersModule } from '../users/users.module.js';
import { StoreAccessService } from './store-access.service.js';
import { StoreWorkspaceService } from './store-workspace.service.js';
import { StoreWorkspaceController } from './store-workspace.controller.js';
import { StoreOperationsService } from './store-operations.service.js';
import { ObjectStorageService } from './object-storage.service.js';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [StoresController, StoreWorkspaceController],
  providers: [
    StoresService,
    StoreAccessService,
    StoreWorkspaceService,
    StoreOperationsService,
    ObjectStorageService,
  ],
  exports: [StoreAccessService],
})
export class StoresModule {}
