import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module.js';
import { CustomerGuard } from './customer.guard.js';
import { CustomersService } from './customers.service.js';
import { CustomersController } from './customers.controller.js';

@Module({
  imports: [AuthModule, ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }])],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerGuard],
  exports: [CustomersService, CustomerGuard, AuthModule],
})
export class CustomersModule {}
