import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import {
  ConfirmStoreOrderDto,
  OrderNumberParamDto,
  ReportOrderIncidentDto,
  ReviewOrderIncidentDto,
} from './order-management.dto.js';
import { OrderManagementService } from './order-management.service.js';

@Controller('order-management')
@UseGuards(JwtAuthGuard, PasswordChangedGuard)
export class OrderManagementController {
  constructor(private readonly orders: OrderManagementService) {}

  @Get('orders/:orderNumber')
  detail(
    @Param() params: OrderNumberParamDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.orders.detail(params.orderNumber, actor);
  }

  @Post('store-orders/:storeOrderId/confirm')
  confirm(
    @Param('storeOrderId', new ParseUUIDPipe()) id: string,
    @Body() input: ConfirmStoreOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.orders.confirm(id, input, actor);
  }

  @Post('store-orders/:storeOrderId/incidents')
  report(
    @Param('storeOrderId', new ParseUUIDPipe()) id: string,
    @Body() input: ReportOrderIncidentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.orders.report(id, input, actor);
  }

  @Patch('incidents/:incidentId/review')
  review(
    @Param('incidentId', new ParseUUIDPipe()) id: string,
    @Body() input: ReviewOrderIncidentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.orders.review(id, input, actor);
  }
}
