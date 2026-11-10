import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  CreateShippingRateDto,
  InformationQueryDto,
  RegisterPayoutDto,
  SetAgencyCommissionRateDto,
  UpsertCalendarDayDto,
} from './admin-information.dto.js';
import { AdminInformationService } from './admin-information.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';

@ApiTags('admin-information')
@ApiBearerAuth()
@Controller('admin/information')
@UseGuards(JwtAuthGuard, PasswordChangedGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminInformationController {
  constructor(private readonly information: AdminInformationService) {}

  @Get('stores')
  stores(@Query() query: InformationQueryDto) {
    return this.information.stores(query);
  }

  @Get('products')
  products(@Query() query: InformationQueryDto) {
    return this.information.products(query);
  }

  @Get('orders')
  orders(@Query() query: InformationQueryDto) {
    return this.information.orders(query);
  }

  @Get('shipments')
  shipments(@Query() query: InformationQueryDto) {
    return this.information.shipments(query);
  }

  @Get('payouts')
  payouts(@Query() query: InformationQueryDto) {
    return this.information.payouts(query);
  }

  @Post('payouts')
  registerPayout(
    @Body() input: RegisterPayoutDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.information.registerPayout(input, actor);
  }

  @Get('ledger')
  ledger(@Query() query: InformationQueryDto) {
    return this.information.ledger(query);
  }

  @Get('settings')
  settings(@Query() query: InformationQueryDto) {
    return this.information.settings(query);
  }

  @Post('settings/agency-commission-rate')
  setAgencyCommissionRate(
    @Body() input: SetAgencyCommissionRateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.information.setAgencyCommissionRate(input, actor);
  }

  @Get('calendar')
  calendar(@Query() query: InformationQueryDto) {
    return this.information.calendar(query);
  }

  @Post('calendar')
  upsertCalendarDay(
    @Body() input: UpsertCalendarDayDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.information.upsertCalendarDay(input, actor);
  }

  @Get('shipping-rates')
  shippingRates(@Query() query: InformationQueryDto) {
    return this.information.shippingRates(query);
  }

  @Post('shipping-rates')
  createShippingRate(
    @Body() input: CreateShippingRateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.information.createShippingRate(input, actor);
  }
}
