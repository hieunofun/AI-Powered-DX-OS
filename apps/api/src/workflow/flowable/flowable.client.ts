import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PROCESS_KEY } from '../domain/workflow-rules';
import { WorkflowError } from '../workflow-error';
import { FlowableTransport, EngineError } from '../../platform/workflow/flowable.transport';
export { EngineError, EngineTask } from '../../platform/workflow/flowable.transport';

// The business adapter keeps process/version/hash policy outside the core.
@Injectable()
export class FlowableClient extends FlowableTransport {
  protected config() {
    if(process.env.FLOWABLE_PROCESS_KEY && process.env.FLOWABLE_PROCESS_KEY!==PROCESS_KEY) throw new EngineError(true);
    return super.config();
  }
  async definition() {
    const all=await this.collection('/repository/process-definitions?key='+PROCESS_KEY+'&latest=true');
    if(all.length!==1 || all[0].suspended) throw new WorkflowError('WORKFLOW_DEFINITION_UNAVAILABLE', 'Deploy the verified WF-1.0 BPMN before starting workflow.');
    await this.verifyDefinition(all[0].id);
    return all[0];
  }
  async verifyDefinition(id: string) {
    const definition = await this.request('/repository/process-definitions/'+encodeURIComponent(id));
    if(definition.key!==PROCESS_KEY || definition.suspended) throw new EngineError(true);
    const xml = await this.request('/repository/process-definitions/'+encodeURIComponent(id)+'/resourcedata','GET',undefined,false,true);
    const expected=readFileSync(resolve(__dirname,'../../../../../infra/flowable/processes/invoice-exception-workflow.bpmn20.xml'),'utf8');
    const hash=(v:string)=>createHash('sha256').update(v.replace(/\r\n/g,'\n').trim()).digest('hex');
    if(hash(xml)!==hash(expected)) throw new WorkflowError('WORKFLOW_DEFINITION_MISMATCH','Deployed BPMN does not match the verified application definition.');
    return definition;
  }
}
