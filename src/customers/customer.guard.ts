import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CustomersService } from './customers.service.js';

@Injectable()
export class CustomerGuard implements CanActivate {
  constructor(private readonly customers: CustomersService) {}
  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    await this.customers.requireCustomer(request.user);
    return true;
  }
}
