import { WorkflowService } from './workflow.service';
import { EngineError } from './flowable/flowable.client';
const actor={sub:'buyer-sub',roles:['buyer'],username:'buyer'};
const approval={id:'case',invoice_id:'invoice',match_result_id:'match',workflow_instance_id:'process',
  match_snapshot:{requiredRoles:['buyer'],requiresFinanceApproval:false,invoiceTotal:'100',discrepancyCodes:['PRICE_MISMATCH']}};
const task={flowable_task_id:'engine-task',task_key:'buyerReview',assigned_role:'buyer',assignee_subject:actor.sub};
const process={id:'process',businessKey:'approval-case:case',processDefinitionId:'definition'};
const active={id:'engine-task',processInstanceId:'process',taskDefinitionKey:'buyerReview',assignee:actor.sub,name:'Buyer review'};
describe('Durable workflow reconciliation (repository/engine mocked)',()=>{
  let repository:any,engine:any,service:WorkflowService,op:any;
  beforeEach(()=>{
    op={id:'operation',operation:'START',status:'PENDING',payload:{},dispatched_at:null,retry_safe:false};
    repository={serialized:jest.fn(async(_,fn)=>fn()),operation:jest.fn(async()=>({op,approval:{...approval},task,actor})),
      dispatch:jest.fn(),failure:jest.fn(),finish:jest.fn(async()=>({caseStatus:'PENDING'})),detail:jest.fn(),
      prepareStart:jest.fn(),prepareAction:jest.fn()};
    engine={processes:jest.fn(async()=>[process]),process:jest.fn(async()=>process),verifyDefinition:jest.fn(async()=>({version:1})),
      tasks:jest.fn(async()=>[{...active,assignee:null}]),identityLinks:jest.fn(async()=>[{type:'candidate',group:'buyer',user:null}]),
      task:jest.fn(async()=>active),historicTask:jest.fn(),start:jest.fn(async()=>process),definition:jest.fn(async()=>({id:'definition'})),
      complete:jest.fn(),claim:jest.fn()};
    service=new WorkflowService(repository,engine);
  });
  it('STP never calls Flowable or creates an operation',async()=>{
    repository.prepareStart.mockResolvedValue({route:'STP',invoiceStatus:'READY_FOR_PAYMENT'});
    expect((await service.start('invoice',actor)).route).toBe('STP'); expect(engine.processes).not.toHaveBeenCalled();
  });
  it('attempts automatic audit only after the terminal transaction returns, without exposing its marker',async()=>{
    let committed=false;
    repository.prepareStart.mockImplementation(async()=>{committed=true;return {route:'STP',invoiceId:'invoice',invoiceStatus:'READY_FOR_PAYMENT',auditScheduled:true};});
    const audit={automatic:jest.fn(async()=>{expect(committed).toBe(true);})};
    service=new WorkflowService(repository,engine,audit as any);
    await expect(service.start('invoice',actor)).resolves.toEqual({route:'STP',invoiceId:'invoice',invoiceStatus:'READY_FOR_PAYMENT'});
    expect(audit.automatic).toHaveBeenCalledWith('invoice');expect(engine.processes).not.toHaveBeenCalled();
  });
  it('active exception setup removes the internal marker and does not seal',async()=>{
    repository.prepareStart.mockResolvedValue({route:'DISCREPANCY_REVIEW',operationId:'operation'});
    repository.finish.mockResolvedValue({invoiceId:'invoice',caseStatus:'PENDING',auditScheduled:false});
    const audit={automatic:jest.fn()};service=new WorkflowService(repository,engine,audit as any);
    const result=await service.start('invoice',actor);
    expect(result).not.toHaveProperty('auditScheduled');expect(audit.automatic).not.toHaveBeenCalled();
  });
  it('adopts existing process after lost DB sync without a second start',async()=>{
    op.dispatched_at=new Date(); op.status='FAILED';
    await service.reconcileOperation('operation');
    expect(engine.start).not.toHaveBeenCalled(); expect(repository.finish).toHaveBeenCalled();
  });
  it('does not replay a timed-out start with no observed process',async()=>{
    engine.processes.mockResolvedValue([]); op.dispatched_at=new Date();
    await expect(service.reconcileOperation('operation')).rejects.toMatchObject({response:{errorCode:'WORKFLOW_RECONCILIATION_REQUIRED'}});
    expect(engine.start).not.toHaveBeenCalled(); expect(repository.failure).toHaveBeenCalledWith('operation','WORKFLOW_RECONCILIATION_REQUIRED',false);
  });
  it('explicit recovery retries a proven connection refusal once',async()=>{
    engine.processes.mockResolvedValue([]); op.dispatched_at=new Date(); op.retry_safe=true;
    await service.reconcileOperation('operation'); expect(engine.start).toHaveBeenCalledTimes(1);
    expect(repository.dispatch).toHaveBeenCalledWith('operation');
  });
  it('records engine outage before dispatch as safe to recover',async()=>{
    engine.processes.mockRejectedValue(new EngineError(true));
    await expect(service.reconcileOperation('operation')).rejects.toMatchObject({status:503});
    expect(repository.failure).toHaveBeenCalledWith('operation','WORKFLOW_ENGINE_UNAVAILABLE',true);
  });
  it('a failed GET cannot turn an earlier ambiguous POST into a safe retry',async()=>{
    op.dispatched_at=new Date(); engine.processes.mockRejectedValue(new EngineError(true));
    await expect(service.reconcileOperation('operation')).rejects.toThrow();
    expect(repository.failure).toHaveBeenCalledWith('operation','WORKFLOW_ENGINE_UNAVAILABLE',false);
  });
  it('DB persistence failure after engine start keeps uncertain durable intent',async()=>{
    engine.processes.mockResolvedValue([]); repository.finish.mockRejectedValue(new Error('private SQL password'));
    await expect(service.reconcileOperation('operation')).rejects.toMatchObject({response:{errorCode:'WORKFLOW_UNAVAILABLE'}});
    expect(repository.failure).toHaveBeenCalledWith('operation','WORKFLOW_PERSISTENCE_FAILED',false);
  });
  it('duplicate remote business keys stop recovery',async()=>{
    engine.processes.mockResolvedValue([process,process]);
    await expect(service.reconcileOperation('operation')).rejects.toMatchObject({response:{errorCode:'WORKFLOW_STATE_MISMATCH'}});
    expect(repository.finish).not.toHaveBeenCalled();
  });
  it.each([{...process,businessKey:'other'},{...process,id:'other'},{...process,deleteReason:'external cancellation'}])(
    'rejects unrelated process evidence %j',async bad=>{
      engine.processes.mockResolvedValue([bad]); await expect(service.reconcileOperation('operation')).rejects.toThrow();
      expect(repository.finish).not.toHaveBeenCalled();
    });
  it('cannot complete a task with a different role in engine',async()=>{
    op.operation='COMPLETE'; op.payload={action:'APPROVE'};
    engine.identityLinks.mockResolvedValue([{type:'candidate',group:'warehouse'}]);
    await expect(service.reconcileOperation('operation')).rejects.toThrow(); expect(engine.complete).not.toHaveBeenCalled();
  });
  it('cannot complete an unowned task for a normal actor',async()=>{
    op.operation='COMPLETE'; op.payload={action:'APPROVE'};
    engine.task.mockResolvedValue({...active,assignee:'someone-else'});
    await expect(service.reconcileOperation('operation')).rejects.toThrow(); expect(engine.complete).not.toHaveBeenCalled();
  });
  it('reconciles completed task only from matching operation history marker',async()=>{
    op.operation='COMPLETE'; op.payload={action:'APPROVE'}; op.dispatched_at=new Date();
    engine.task.mockResolvedValue(null); engine.tasks.mockResolvedValue([]);
    engine.process.mockResolvedValue({...process,endTime:'now',endActivityId:'approved'});
    engine.historicTask.mockResolvedValue({...active,endTime:'now',variables:[{name:'applicationOperationId',value:'operation'}]});
    await service.reconcileOperation('operation'); expect(engine.complete).not.toHaveBeenCalled(); expect(repository.finish).toHaveBeenCalled();
  });
  it('missing command marker never fabricates a decision',async()=>{
    op.operation='COMPLETE'; op.payload={action:'APPROVE'}; engine.task.mockResolvedValue(null);
    engine.historicTask.mockResolvedValue({...active,endTime:'now',variables:[]});
    await expect(service.reconcileOperation('operation')).rejects.toThrow(); expect(repository.finish).not.toHaveBeenCalled();
  });
  it('reconciles a successful claim after lost DB write without a second claim',async()=>{
    op.operation='CLAIM'; op.dispatched_at=new Date();
    await service.reconcileOperation('operation'); expect(engine.claim).not.toHaveBeenCalled(); expect(repository.finish).toHaveBeenCalled();
  });
});

