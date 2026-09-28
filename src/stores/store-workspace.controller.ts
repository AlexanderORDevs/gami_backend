import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { InformationQueryDto } from '../admin-information/admin-information.dto.js';
import { StoreAccessService } from './store-access.service.js';
import { StoreWorkspaceService } from './store-workspace.service.js';
import { StoreOperationsService } from './store-operations.service.js';
import {
  AdjustStoreInventoryDto,
  CreateStoreOrderDto,
  CreateStoreProductDto,
  CreateStoreShipmentDto,
  PRODUCT_OPTIONS,
} from './store-operations.dto.js';
import {
  CreateStoreUserDto,
  StoreInformationResource,
  UpdateStoreMemberDto,
} from './store-workspace.dto.js';

@ApiTags('store-workspace')
@ApiBearerAuth()
@Controller('store-workspace/stores')
@UseGuards(JwtAuthGuard, PasswordChangedGuard)
export class StoreWorkspaceController {
  constructor(
    private readonly access: StoreAccessService,
    private readonly workspace: StoreWorkspaceService,
    private readonly operations: StoreOperationsService,
  ) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.access.list(actor);
  }

  @Get(':storeId/information/:resource')
  information(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('resource', new ParseEnumPipe(StoreInformationResource))
    resource: StoreInformationResource,
    @Query() query: InformationQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.workspace.information(storeId, resource, query, actor);
  }

  @Get(':storeId/profile')
  profile(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.workspace.profile(storeId, actor);
  }

  @Get(':storeId/operation-options')
  async operationOptions(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.access.require(storeId, actor, 'profile');
    return PRODUCT_OPTIONS;
  }

  @Get(':storeId/order-variants')
  orderVariants(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Query() query: InformationQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.variants(
      storeId,
      actor,
      query.search,
      query.page,
      true,
    );
  }

  @Get(':storeId/inventory-variants')
  inventoryVariants(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Query() query: InformationQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.variants(storeId, actor, query.search, query.page);
  }

  @Get(':storeId/shipment-orders')
  shipmentOrders(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Query() query: InformationQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.shipmentOrders(
      storeId,
      actor,
      query.search,
      query.page,
    );
  }

  @Post(':storeId/products')
  createProduct(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() input: CreateStoreProductDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.operations.createProduct(storeId, input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Patch(':storeId/inventory/:variantId')
  adjustInventory(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body() input: AdjustStoreInventoryDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.operations.adjustInventory(storeId, variantId, input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Post(':storeId/orders')
  createOrder(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() input: CreateStoreOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.operations.createOrder(storeId, input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Post(':storeId/shipments')
  createShipment(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() input: CreateStoreShipmentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.operations.createShipment(storeId, input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Get(':storeId/members')
  members(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Query() query: InformationQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.workspace.members(storeId, query, actor);
  }

  @Post(':storeId/members')
  create(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() input: CreateStoreUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.workspace.createMember(storeId, input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Patch(':storeId/members/:userId')
  update(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: UpdateStoreMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.workspace.updateMember(storeId, userId, input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }
}
