import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { WorkflowService } from './workflow.service';
import { CompleteTaskDto, UpdateWorkflowPolicyDto } from './workflow.dto';
import { WorkflowError } from './workflow-error';
const READ=['accountant','admin','finance_manager','buyer','warehouse'];
function empty(body: unknown) {
  if(body!=null && (typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))
    throw new WorkflowError('WORKFLOW_INPUT_NOT_ALLOWED','Business inputs are loaded from the database; this action accepts an empty body.',400);
}
@ApiTags('Invoice workflow') @ApiBearerAuth('bearer')
@Controller() @UseGuards(JwtAuthGuard,RolesGuard)
export class WorkflowController {
  constructor(private readonly service: WorkflowService) {}
  @Post('invoices/:invoiceId/workflow/start') @HttpCode(200) @Roles('accountant','admin')
  start(@Param('invoiceId',ParseUUIDPipe) id: string,@Body() body: unknown,@CurrentUser() actor: AuthenticatedUser) { empty(body); return this.service.start(id,actor); }
  @Get('approval-cases') @Roles(...READ)
  cases() { return this.service.cases(); }
  @Get('approval-cases/:id') @Roles(...READ)
  detail(@Param('id',ParseUUIDPipe) id: string) { return this.service.detail(id); }
  @Get('approval-cases/:id/tasks') @Roles(...READ)
  tasks(@Param('id',ParseUUIDPipe) id: string) { return this.service.tasks(id); }
  @Get('my-approval-tasks') @Roles(...READ)
  myTasks(@CurrentUser() actor: AuthenticatedUser) { return this.service.myTasks(actor); }
  @Post('approval-tasks/:taskId/claim') @HttpCode(200) @Roles(...READ)
  claim(@Param('taskId',ParseUUIDPipe) id: string,@Body() body: unknown,@CurrentUser() actor: AuthenticatedUser) { empty(body); return this.service.claim(id,actor); }
  @Post('approval-tasks/:taskId/complete') @HttpCode(200) @Roles(...READ)
  complete(@Param('taskId',ParseUUIDPipe) id: string,@Body() dto: CompleteTaskDto,@CurrentUser() actor: AuthenticatedUser) { return this.service.complete(id,dto,actor); }
  @Get('workflow/policy') @Roles(...READ)
  policy() { return this.service.policy(); }
  @Patch('workflow/policy') @Roles('admin')
  updatePolicy(@Body() dto: UpdateWorkflowPolicyDto,@CurrentUser() actor: AuthenticatedUser) { return this.service.updatePolicy(dto,actor); }
}

