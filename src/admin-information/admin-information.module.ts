import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminInformationController } from './admin-information.controller.js';
import { AdminInformationService } from './admin-information.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminInformationController],
  providers: [AdminInformationService],
})
export class AdminInformationModule {}
