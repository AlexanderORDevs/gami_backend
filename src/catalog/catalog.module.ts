import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { ThrottlerModule } from '@nestjs/throttler';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { CustomersModule } from '../customers/customers.module.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 30 }]),
    CustomersModule,
  ],
  controllers: [CatalogController, CheckoutController],
  providers: [CatalogService, CheckoutService],
})
export class CatalogModule {}
