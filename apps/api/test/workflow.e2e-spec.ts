import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { WorkflowRepository } from '../src/workflow/workflow.repository';
import { FlowableClient, EngineError } from '../src/workflow/flowable/flowable.client';
import { WorkflowError } from '../src/workflow/workflow-error';
describe('Workflow HTTP contracts (authentication, repository and Flowable mocked)',()=>{
  let app:INestApplication;
  const id=randomUUID(),caseId=randomUUID(),taskId=randomUUID();
  const roles=['accountant','admin','buyer','warehouse','finance_manager'];
  const policy={id:randomUUID(),policyCode:'WORKFLOW_DEFAULT',autoReadyForPaymentMaxAmount:null,financeApprovalThreshold:'100000000.00'};
  const repo={prepareStart:jest.fn(async()=>({route:'STP',invoiceId:id,invoiceStatus:'READY_FOR_PAYMENT'})),
    cases:jest.fn(async()=>[]),detail:jest.fn(async()=>({id:caseId,status:'PENDING'})),tasks:jest.fn(async()=>[]),
    invoiceCase:jest.fn(async()=>({id:caseId,invoiceId:id,status:'PENDING'})),
    myTasks:jest.fn(async()=>[]),policy:jest.fn(async()=>policy),updatePolicy:jest.fn(async dto=>({...policy,...dto})),
    prepareAction:jest.fn(async()=>({taskId,idempotent:true})),serialized:jest.fn(async(_id,fn)=>fn()),
    operation:jest.fn(),dispatch:jest.fn(),finish:jest.fn(async()=>({approvalCaseId:caseId,caseStatus:'PENDING'})),failure:jest.fn(),
    ensureQuantityReservation:jest.fn(async()=>undefined)};
  const process={id:'process',businessKey:'approval-case:'+caseId,processDefinitionId:'definition'};
  const engineTask={id:'engine-task',processInstanceId:'process',taskDefinitionKey:'buyerReview',name:'Buyer review',assignee:null};
  const approval={id:caseId,invoice_id:id,match_result_id:'match',workflow_instance_id:'process',
    match_snapshot:{requiredRoles:['buyer'],requiresFinanceApproval:false}};
  const engine={processes:jest.fn(),process:jest.fn(),task:jest.fn(),complete:jest.fn(),historicTask:jest.fn(),
    verifyDefinition:jest.fn(async()=>({version:1})),tasks:jest.fn(async()=>[engineTask]),
    identityLinks:jest.fn(async()=>[{type:'candidate',group:'buyer'}])};
  const auth=(role='accountant')=>['Authorization','Bearer '+role] as const;
  beforeAll(async()=>{
    const module=await Test.createTestingModule({imports:[AppModule]})
      .overrideProvider(AuthService).useValue({verifyToken:async token=>{
        if(!roles.includes(token)) throw new UnauthorizedException();
        return {sub:'sub-'+token,username:token,roles:[token]};
      }}).overrideProvider(WorkflowRepository).useValue(repo).overrideProvider(FlowableClient).useValue(engine).compile();
    app=module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true,transformOptions:{enableImplicitConversion:true}}));
    await app.init();
  });
  afterAll(()=>app.close());
  it.each(['accountant','admin'])('%s starts STP with no client business data',async role=>{
    const res=await request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').set(...auth(role)).expect(200);
    expect(res.body).toMatchObject({route:'STP',invoiceStatus:'READY_FOR_PAYMENT'});
  });
  it.each(['buyer','warehouse','finance_manager'])('%s cannot start',role=>
    request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').set(...auth(role)).expect(403));
  it('anonymous start is 401',()=>request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').expect(401));
  it.each([{requiredRole:'buyer'},{invoiceTotal:'0'},{discrepancyCodes:[]},{matchStatus:'PASSED'},{financeThreshold:'0'},[]])(
    'rejects untrusted business data %j',body=>request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').set(...auth()).send(body).expect(400));
  it.each(roles)('%s reads cases, tasks and policy',async role=>{
    for(const path of ['/approval-cases','/approval-cases/'+caseId,'/approval-cases/'+caseId+'/tasks','/my-approval-tasks','/workflow/policy','/invoices/'+id+'/workflow'])
      await request(app.getHttpServer()).get(path).set(...auth(role)).expect(200);
  });
  it('anonymous read is 401',()=>request(app.getHttpServer()).get('/approval-cases').expect(401));
  it('UUID validation',()=>request(app.getHttpServer()).get('/approval-cases/not-uuid').set(...auth()).expect(400));
  it('invoice lookup distinguishes absent approval cases from service failure',async()=>{
    repo.invoiceCase.mockRejectedValueOnce(new WorkflowError('APPROVAL_CASE_NOT_FOUND','No approval case exists.',404));
    const res=await request(app.getHttpServer()).get('/invoices/'+id+'/workflow').set(...auth()).expect(404);
    expect(res.body.errorCode).toBe('APPROVAL_CASE_NOT_FOUND');
    repo.invoiceCase.mockRejectedValueOnce(new Error('SELECT private-data'));
    const unavailable=await request(app.getHttpServer()).get('/invoices/'+id+'/workflow').set(...auth()).expect(503);
    expect(unavailable.body.errorCode).toBe('WORKFLOW_UNAVAILABLE');
    expect(JSON.stringify(unavailable.body)).not.toContain('private-data');
  });
  it('invoice lookup rejects anonymous and invalid identifiers',async()=>{
    await request(app.getHttpServer()).get('/invoices/'+id+'/workflow').expect(401);
    await request(app.getHttpServer()).get('/invoices/not-uuid/workflow').set(...auth()).expect(400);
  });
  it.each([['INVOICE_NOT_FOUND',404],['INVALID_INVOICE_STATE',409],['WORKFLOW_ALREADY_EXISTS',409]])(
    '%s is safe %s',async(code,status)=>{
      repo.prepareStart.mockRejectedValueOnce(new WorkflowError(String(code),'Safe response.',Number(status)));
      const res=await request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').set(...auth()).expect(Number(status));
      expect(res.body.errorCode).toBe(code);
    });
  it('engine outage on exception start returns 503 without fabricated PENDING success',async()=>{
    repo.prepareStart.mockResolvedValueOnce({route:'EXCEPTION_REVIEW',operationId:id} as any);
    repo.operation.mockResolvedValueOnce({op:{operation:'START',status:'PENDING',payload:{}},approval:{id:caseId},actor:{sub:'a',roles:['accountant']}});
    engine.processes.mockRejectedValueOnce(new EngineError(true));
    const res=await request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').set(...auth()).expect(503);
    expect(res.body.errorCode).toBe('WORKFLOW_ENGINE_UNAVAILABLE'); expect(repo.failure).toHaveBeenCalled();
  });
  it('technical error does not leak SQL or credentials',async()=>{
    repo.prepareStart.mockRejectedValueOnce(new Error('SELECT password super-secret'));
    const res=await request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').set(...auth()).expect(503);
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|password|super-secret/);
  });
  it('exception start returns the confirmed persisted case',async()=>{
    repo.prepareStart.mockResolvedValueOnce({route:'EXCEPTION_REVIEW',operationId:id} as any);
    repo.operation.mockResolvedValueOnce({op:{operation:'START',status:'PENDING'},approval,actor:{sub:'sub-accountant',roles:['accountant']}});
    engine.processes.mockResolvedValueOnce([process]);
    const res=await request(app.getHttpServer()).post('/invoices/'+id+'/workflow/start').set(...auth()).expect(200);
    expect(res.body).toMatchObject({route:'EXCEPTION_REVIEW',approvalCaseId:caseId,caseStatus:'PENDING'});
  });
  it('owned task completion returns the confirmed result through the HTTP contract',async()=>{
    repo.prepareAction.mockResolvedValueOnce({operationId:id} as any);
    repo.operation.mockResolvedValueOnce({op:{operation:'COMPLETE',status:'PENDING',payload:{action:'APPROVE'}},approval,
      task:{flowable_task_id:'engine-task',task_key:'buyerReview',assigned_role:'buyer'},
      actor:{sub:'sub-buyer',roles:['buyer']}});
    engine.process.mockResolvedValueOnce(process).mockResolvedValueOnce({...process,endTime:'now',endActivityId:'approved'});
    engine.task.mockResolvedValueOnce({...engineTask,assignee:'sub-buyer'});
    engine.historicTask.mockResolvedValueOnce({...engineTask,endTime:'now',variables:[{name:'applicationOperationId',value:id}]});
    engine.tasks.mockResolvedValueOnce([]);
    repo.finish.mockResolvedValueOnce({approvalCaseId:caseId,caseStatus:'APPROVED',invoiceStatus:'READY_FOR_PAYMENT'} as any);
    const res=await request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/complete').set(...auth('buyer')).send({action:'APPROVE'}).expect(200);
    expect(res.body).toMatchObject({caseStatus:'APPROVED',invoiceStatus:'READY_FOR_PAYMENT'});
    expect(engine.complete).toHaveBeenLastCalledWith('engine-task','APPROVE',id);
  });
  it('quantity conflicts surface as HTTP 409 before an approval intent or remote call',async()=>{
    repo.prepareAction.mockRejectedValueOnce(new WorkflowError('INSUFFICIENT_RECEIVED_QUANTITY','Received quantity is reserved.',409));
    const before=engine.complete.mock.calls.length;
    const res=await request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/complete').set(...auth('buyer')).send({action:'APPROVE'}).expect(409);
    expect(res.body.errorCode).toBe('INSUFFICIENT_RECEIVED_QUANTITY');
    expect(engine.complete.mock.calls.length).toBe(before);
  });
  it('claim passes authenticated subject to repository',async()=>{
    await request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/claim').set(...auth('buyer')).expect(200);
    expect(repo.prepareAction).toHaveBeenLastCalledWith(taskId,'CLAIM',{},expect.objectContaining({sub:'sub-buyer',roles:['buyer']}));
  });
  it('claim rejects body role injection',()=>request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/claim').set(...auth()).send({role:'admin'}).expect(400));
  it.each(['TASK_ROLE_FORBIDDEN','TASK_NOT_OWNED'])('%s is 403',async code=>{
    repo.prepareAction.mockRejectedValueOnce(new WorkflowError(code,'Forbidden.',403));
    await request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/complete').set(...auth('warehouse')).send({action:'APPROVE'}).expect(403);
  });
  it.each(['TASK_ALREADY_CLAIMED','TASK_ALREADY_COMPLETED'])('%s is 409',async code=>{
    repo.prepareAction.mockRejectedValueOnce(new WorkflowError(code,'Conflict.',409));
    await request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/claim').set(...auth()).expect(409);
  });
  it.each(['APPROVE','APPROVE_WITH_ADJUSTMENT','REJECT','REQUEST_CREDIT_NOTE'])('strict action %s reaches service',async action=>{
    repo.prepareAction.mockRejectedValueOnce(new WorkflowError('STOP','Validated.',409));
    await request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/complete').set(...auth('buyer')).send({action,reason:'Documented reason'}).expect(409);
    expect(repo.prepareAction).toHaveBeenLastCalledWith(taskId,'COMPLETE',{action,reason:'Documented reason'},expect.anything());
  });
  it.each([{action:'PAY'},{action:1},{action:'REJECT'},{action:'REJECT',reason:'  '},{action:'REQUEST_CREDIT_NOTE',reason:null},
    {action:'APPROVE_WITH_ADJUSTMENT'},{action:'APPROVE',reason:4},{action:'APPROVE',requiredRole:'admin'},{action:'APPROVE',reason:'x'.repeat(2001)}])(
    'rejects invalid decision %j',body=>request(app.getHttpServer()).post('/approval-tasks/'+taskId+'/complete').set(...auth()).send(body).expect(400));
  it('admin may update exact decimal policy and reset cap NULL',async()=>{
    const res=await request(app.getHttpServer()).patch('/workflow/policy').set(...auth('admin'))
      .send({financeApprovalThreshold:'9999999999999999.99',autoReadyForPaymentMaxAmount:null}).expect(200);
    expect(res.body.autoReadyForPaymentMaxAmount).toBeNull();
  });
  it.each(['accountant','buyer','warehouse','finance_manager'])('%s cannot edit policy',role=>
    request(app.getHttpServer()).patch('/workflow/policy').set(...auth(role)).send({financeApprovalThreshold:'0'}).expect(403));
  it.each([1,null,true,'-1','1e2','NaN','Infinity','1.001','10000000000000000',' 1',''])('strict amount %j',value=>
    request(app.getHttpServer()).patch('/workflow/policy').set(...auth('admin')).send({financeApprovalThreshold:value}).expect(400));
  it.each([{}, {isActive:false},{autoReadyForPaymentMaxAmount:100}])('rejects invalid policy update %j',body=>
    request(app.getHttpServer()).patch('/workflow/policy').set(...auth('admin')).send(body).expect(400));
});

