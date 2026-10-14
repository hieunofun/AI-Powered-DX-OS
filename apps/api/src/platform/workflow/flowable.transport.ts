import { Injectable } from '@nestjs/common';
import { WorkflowError } from './workflow-error';
import { EngineTask,WorkflowEnginePort } from './workflow-engine.port';
export { EngineTask } from './workflow-engine.port';
export class EngineError extends WorkflowError {
  constructor(public readonly retrySafe = false) {
    super('WORKFLOW_ENGINE_UNAVAILABLE', 'Workflow engine operation could not be confirmed. Use reconciliation before retry.', 503);
  }
}
@Injectable()
export class FlowableTransport implements WorkflowEnginePort {
  protected config() {
    const url = process.env.FLOWABLE_URL, username = process.env.FLOWABLE_USERNAME, password = process.env.FLOWABLE_PASSWORD;
    const timeout = Number(process.env.FLOWABLE_TIMEOUT_MS || '10000');
    if (!url || !username || !password || !/^https?:\/\//.test(url) || !Number.isInteger(timeout) || timeout<100 || timeout>30000) throw new EngineError(true);
    return { url: url.replace(/\/$/, ''), auth: 'Basic '+Buffer.from(username+':'+password).toString('base64'), timeout };
  }
  protected async request(path: string, method = 'GET', body?: unknown, missing = false, raw = false): Promise<any> {
    const c = this.config();
    try {
      const response = await fetch(c.url+path,{ method, signal: AbortSignal.timeout(c.timeout),
        headers:{ Authorization:c.auth,...(body===undefined?{}:{'Content-Type':'application/json'}) },
        ...(body===undefined?{}:{body:JSON.stringify(body)}) });
      if (missing && response.status===404) return null;
      if (!response.ok) throw new EngineError(method==='GET' || [400,401,403,404,409].includes(response.status));
      const content=await response.text();
      return raw ? content : content ? JSON.parse(content) : null;
    } catch(error) {
      if (error instanceof EngineError) throw error;
      // Connection refusal/DNS failure occur before the request reaches the engine.
      throw new EngineError(method==='GET' || ['ECONNREFUSED','ENOTFOUND'].includes(error?.cause?.code));
    }
  }
  protected async collection(path: string): Promise<any[]> {
    const result = await this.request(path+(path.includes('?')?'&':'?')+'size=1000');
    if (!Array.isArray(result?.data) || result.total>result.data.length) throw new EngineError();
    return result.data;
  }
  start(definitionId: string, businessKey: string, variables: Record<string,string|boolean>) {
    return this.request('/runtime/process-instances','POST',{processDefinitionId:definitionId,businessKey,
      variables:Object.entries(variables).map(([name,value])=>({name,value,type:typeof value==='boolean'?'boolean':'string'}))});
  }
  async processes(businessKey: string) {
    // History includes running and completed processes; history level must remain audit/full.
    return this.collection('/history/historic-process-instances?businessKey='+encodeURIComponent(businessKey));
  }
  process(id: string) { return this.request('/history/historic-process-instances/'+encodeURIComponent(id),'GET',undefined,true); }
  tasks(id: string): Promise<EngineTask[]> { return this.collection('/runtime/tasks?processInstanceId='+encodeURIComponent(id)); }
  task(id: string): Promise<EngineTask | null> { return this.request('/runtime/tasks/'+encodeURIComponent(id),'GET',undefined,true); }
  async historicTask(id: string) {
    const rows=await this.collection('/history/historic-task-instances?taskId='+encodeURIComponent(id)+'&includeTaskLocalVariables=true');
    if(rows.length>1) throw new EngineError();
    return rows[0]??null;
  }
  identityLinks(id: string) { return this.request('/runtime/tasks/'+encodeURIComponent(id)+'/identitylinks'); }
  claim(id: string, subject: string) { return this.request('/runtime/tasks/'+encodeURIComponent(id),'POST',{action:'claim',assignee:subject}); }
  complete(id: string, action: string, operationId: string) {
    return this.request('/runtime/tasks/'+encodeURIComponent(id),'POST',{action:'complete',variables:[
      {name:'action',value:action,type:'string',scope:'global'},
      {name:'applicationOperationId',value:operationId,type:'string',scope:'local'},
    ]});
  }
}

