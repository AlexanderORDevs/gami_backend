import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PasswordChangedGuard } from './password-changed.guard.js';
import { PasswordResetMailer } from './password-reset-mailer.service.js';
import { RolesGuard } from './roles.guard.js';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    PasswordChangedGuard,
    PasswordResetMailer,
    RolesGuard,
  ],
  exports: [
    JwtModule,
    AuthService,
    JwtAuthGuard,
    PasswordChangedGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
