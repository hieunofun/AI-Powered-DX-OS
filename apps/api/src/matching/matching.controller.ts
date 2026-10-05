import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MatchingService } from './matching.service';
import { MatchingError } from './matching-error';
import { UpdateMatchingPolicyDto } from './dto/update-matching-policy.dto';
const READ_ROLES = ['accountant', 'admin', 'finance_manager', 'buyer', 'warehouse'];

@ApiTags('Matching') @ApiBearerAuth('bearer')
@Controller() @UseGuards(JwtAuthGuard, RolesGuard)
export class MatchingController {
  constructor(private readonly service: MatchingService) {}
  @Post('invoices/:invoiceId/match') @HttpCode(200) @Roles('accountant', 'admin')
  @ApiOperation({ summary: 'Evaluate trusted database invoice/PO/accepted-GRN state atomically' })
  @ApiBody({ required: false, schema: { type: 'object', additionalProperties: false } })
  match(@Param('invoiceId', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    if (body != null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)) {
      throw new MatchingError('MATCH_INPUT_NOT_ALLOWED', 'The match request accepts only the invoice ID in its path.', 400);
    }
    return this.service.match(id, user);
  }
  @Get('invoices/:invoiceId/match-result') @Roles(...READ_ROLES)
  invoiceResult(@Param('invoiceId', ParseUUIDPipe) id: string) { return this.service.invoiceResult(id); }
  @Get('match-results/:id') @Roles(...READ_ROLES)
  result(@Param('id', ParseUUIDPipe) id: string) { return this.service.result(id); }
  @Get('matching/policy') @Roles(...READ_ROLES)
  policy() { return this.service.policy(); }
  @Patch('matching/policy') @Roles('admin')
  updatePolicy(@Body() dto: UpdateMatchingPolicyDto, @CurrentUser() user: AuthenticatedUser) { return this.service.updatePolicy(dto, user); }
}
