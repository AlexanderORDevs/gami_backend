import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CreateStoreDto, UpdateStoreDto } from './stores.dto.js';
import { StoresService } from './stores.service.js';

@ApiTags('admin-stores')
@ApiBearerAuth()
@Controller('admin/stores')
@UseGuards(JwtAuthGuard, PasswordChangedGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.stores.detail(id);
  }

  @Get(':id/audit-log')
  history(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.stores.history(id);
  }

  @Post()
  create(
    @Body() input: CreateStoreDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.stores.create(input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateStoreDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.stores.update(id, input, actor, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }
}
