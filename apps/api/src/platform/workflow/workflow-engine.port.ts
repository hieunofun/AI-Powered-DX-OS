export interface EngineTask {
  id:string;
  processInstanceId:string;
  taskDefinitionKey:string;
  name:string;
  assignee:string|null;
}

// Engine transport does not authorize business actions or own durable intents.
// Callers must persist/reconcile uncertain writes before redispatching them.
export interface WorkflowEnginePort {
  start(definitionId:string,businessKey:string,variables:Record<string,string|boolean>):Promise<any>;
  processes(businessKey:string):Promise<any[]>;
  process(id:string):Promise<any|null>;
  tasks(id:string):Promise<EngineTask[]>;
  task(id:string):Promise<EngineTask|null>;
  historicTask(id:string):Promise<any|null>;
  identityLinks(id:string):Promise<any>;
  claim(id:string,subject:string):Promise<any>;
  complete(id:string,action:string,operationId:string):Promise<any>;
}
