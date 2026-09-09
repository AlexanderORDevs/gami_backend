import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PasswordChangedGuard } from '../auth/password-changed.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthenticatedUser, RequestContext } from '../auth/auth.types.js';
import {
  AuditReasonDto,
  CreateUserDto,
  RoleCodeDto,
  StoreMembershipDto,
  TemporaryPasswordResponseDto,
  UpdateUserStatusDto,
  UserAuditListResponseDto,
  UserAuditQueryDto,
  UserListQueryDto,
  UserListResponseDto,
  UserResponseDto,
} from './dto/users.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('admin-users')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, PasswordChangedGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('roles')
  @ApiOperation({ summary: 'List assignable roles' })
  listRoles() {
    return this.users.listRoles();
  }

  @Get('users')
  @ApiOperation({ summary: 'List users with filters and pagination' })
  @ApiOkResponse({ type: UserListResponseDto })
  list(@Query() query: UserListQueryDto): Promise<UserListResponseDto> {
    return this.users.list(query);
  }

  @Post('users')
  @ApiOperation({ summary: 'Create a user with a one-time temporary password' })
  @ApiCreatedResponse()
  create(
    @Body() input: CreateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.users.create(input, actor, this.context(request));
  }

  @Get('users/:userId')
  @ApiOperation({ summary: 'Get one user and effective access assignments' })
  @ApiOkResponse({ type: UserResponseDto })
  getById(
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<UserResponseDto> {
    return this.users.getById(userId);
  }

  @Get('users/:userId/audit-log')
  @ApiOperation({ summary: 'List immutable audit history for one user' })
  @ApiOkResponse({ type: UserAuditListResponseDto })
  getAuditLog(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: UserAuditQueryDto,
  ): Promise<UserAuditListResponseDto> {
    return this.users.getAuditLog(userId, query);
  }

  @Patch('users/:userId/status')
  @ApiOperation({ summary: 'Change user status and revoke active sessions' })
  @ApiOkResponse({ type: UserResponseDto })
  updateStatus(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: UpdateUserStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<UserResponseDto> {
    return this.users.updateStatus(
      userId,
      input.status,
      input.reason,
      actor,
      this.context(request),
    );
  }

  @Post('users/:userId/roles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant a role to a user' })
  @ApiOkResponse({ type: UserResponseDto })
  grantRole(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: RoleCodeDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<UserResponseDto> {
    return this.users.grantRole(
      userId,
      input.roleCode,
      input.reason,
      actor,
      this.context(request),
    );
  }

  @Delete('users/:userId/roles/:roleCode')
  @ApiOperation({ summary: 'Revoke a role and invalidate user sessions' })
  @ApiOkResponse({ type: UserResponseDto })
  revokeRole(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('roleCode') roleCode: string,
    @Body() input: AuditReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<UserResponseDto> {
    return this.users.revokeRole(
      userId,
      roleCode.trim().toUpperCase(),
      input.reason,
      actor,
      this.context(request),
    );
  }

  @Post('users/:userId/stores')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant or reactivate access to a store' })
  @ApiOkResponse({ type: UserResponseDto })
  grantStore(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: StoreMembershipDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<UserResponseDto> {
    return this.users.grantStore(
      userId,
      input.storeId,
      input.isOwner,
      input.reason,
      actor,
      this.context(request),
    );
  }

  @Delete('users/:userId/stores/:storeId')
  @ApiOperation({
    summary: 'Deactivate store access and invalidate user sessions',
  })
  @ApiOkResponse({ type: UserResponseDto })
  revokeStore(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() input: AuditReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<UserResponseDto> {
    return this.users.revokeStore(
      userId,
      storeId,
      input.reason,
      actor,
      this.context(request),
    );
  }

  @Post('users/:userId/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a one-time temporary password' })
  @ApiOkResponse({ type: TemporaryPasswordResponseDto })
  resetPassword(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: AuditReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<TemporaryPasswordResponseDto> {
    return this.users.resetPassword(
      userId,
      input.reason,
      actor,
      this.context(request),
    );
  }

  @Delete('users/:userId/sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke every active session for a user' })
  @ApiNoContentResponse()
  revokeSessions(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: AuditReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<void> {
    return this.users.revokeSessions(
      userId,
      input.reason,
      actor,
      this.context(request),
    );
  }

  private context(request: Request): RequestContext {
    return {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}
