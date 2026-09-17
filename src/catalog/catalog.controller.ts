import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CatalogQueryDto } from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  @ApiOperation({ summary: 'Browse public products without authentication' })
  list(@Query() query: CatalogQueryDto) {
    return this.catalog.list(query);
  }

  @Get('products/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.detail(id);
  }

  @Get('filters')
  filters() {
    return this.catalog.filters();
  }
}
