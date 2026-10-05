import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
const strict = () => Transform(({obj,key})=>obj[key]);
export class CompleteTaskDto {
  @ApiProperty({enum:['APPROVE','APPROVE_WITH_ADJUSTMENT','REJECT','REQUEST_CREDIT_NOTE']})
  @strict() @IsIn(['APPROVE','APPROVE_WITH_ADJUSTMENT','REJECT','REQUEST_CREDIT_NOTE'])
  action: string;
  @ApiPropertyOptional({maxLength:2000})
  @strict() @ValidateIf((obj,value)=>obj.action!=='APPROVE'||value!==undefined)
  @IsString() @MaxLength(2000) @Matches(/\S/,{message:'A nonblank resolution reason is required.'})
  reason?: string;
}
export class UpdateWorkflowPolicyDto {
  @ApiPropertyOptional({type:String,example:'100000000.00'})
  @strict() @ValidateIf((_,value)=>value!==undefined) @IsString() @Matches(/^\d{1,16}(\.\d{1,2})?$/)
  financeApprovalThreshold?: string;
  @ApiPropertyOptional({type:String,nullable:true,description:'NULL permits all clean invoices; otherwise inclusive STP maximum.'})
  @strict() @ValidateIf((_,value)=>value!==undefined&&value!==null) @IsString() @Matches(/^\d{1,16}(\.\d{1,2})?$/)
  autoReadyForPaymentMaxAmount?: string|null;
}

