import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StoresController } from './stores.controller.js';
import { StoresService } from './stores.service.js';

@Module({
  imports: [AuthModule],
  controllers: [StoresController],
  providers: [StoresService],
})
export class StoresModule {}
