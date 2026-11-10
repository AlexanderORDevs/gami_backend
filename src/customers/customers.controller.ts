import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { LoginDto } from '../auth/dto/auth.dto.js';
import { InformationQueryDto } from '../admin-information/admin-information.dto.js';
import { CustomerGuard } from './customer.guard.js';
import { CustomersService } from './customers.service.js';
import {
  CustomerCartQuantityDto,
  CustomerProfileDto,
  RegisterCustomerDto,
} from './customers.dto.js';

@Controller('customers')
@UseGuards(ThrottlerGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  register(@Body() input: RegisterCustomerDto, @Req() request: Request) {
    return this.customers.register(input, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  login(@Body() input: LoginDto, @Req() request: Request) {
    return this.customers.login(input, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  profile(@CurrentUser() actor: AuthenticatedUser) {
    return this.customers.profile(actor);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  updateProfile(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CustomerProfileDto,
  ) {
    return this.customers.updateProfile(actor, input);
  }

  @Get('me/cart')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  cart(@CurrentUser() actor: AuthenticatedUser) {
    return this.customers.cart(actor);
  }

  @Put('me/cart/:variantId')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  setCartItem(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body() input: CustomerCartQuantityDto,
  ) {
    return this.customers.setCartItem(actor, variantId, input.quantity);
  }

  @Delete('me/cart/:variantId')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  removeCartItem(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
  ) {
    return this.customers.removeCartItem(actor, variantId);
  }

  @Get('me/favorites')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  favorites(@CurrentUser() actor: AuthenticatedUser) {
    return this.customers.favorites(actor);
  }

  @Put('me/favorites/:productId')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  favorite(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    return this.customers.favorite(actor, productId, true);
  }

  @Delete('me/favorites/:productId')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  removeFavorite(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    return this.customers.favorite(actor, productId, false);
  }

  @Get('me/orders')
  @UseGuards(JwtAuthGuard, CustomerGuard)
  orders(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: InformationQueryDto,
  ) {
    return this.customers.orders(actor, query.page);
  }
}
