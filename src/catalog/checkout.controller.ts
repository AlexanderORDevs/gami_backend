import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { CheckoutService } from './checkout.service.js';
import { CheckoutOrderDto, CheckoutQuoteDto } from './checkout.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CustomerGuard } from '../customers/customer.guard.js';

@ApiTags('checkout')
@Controller('checkout')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get('destinations')
  destinations() {
    return this.checkout.destinations();
  }

  @Post('quote')
  quote(@Body() input: CheckoutQuoteDto) {
    return this.checkout.quote(input);
  }

  @Post('orders')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, CustomerGuard)
  create(
    @Body() input: CheckoutOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.checkout.create(input, actor);
  }
}
