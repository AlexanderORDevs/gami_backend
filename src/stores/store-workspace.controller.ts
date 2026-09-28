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
