import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service.js';

type HealthResponse = {
  status: 'ok';
  services: {
    api: 'up';
    database: 'up';
  };
  timestamp: string;
};

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Check API and database availability' })
  async check(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }

    return {
      status: 'ok',
      services: {
        api: 'up',
        database: 'up',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
