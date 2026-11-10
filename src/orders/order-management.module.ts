import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { StoresModule } from '../stores/stores.module.js';
import { OrderManagementController } from './order-management.controller.js';
import { OrderManagementService } from './order-management.service.js';

@Module({
  imports: [AuthModule, CustomersModule, StoresModule],
  controllers: [OrderManagementController],
  providers: [OrderManagementService],
})
export class OrderManagementModule {}
