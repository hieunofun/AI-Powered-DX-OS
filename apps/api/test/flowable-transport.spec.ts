import { FlowableTransport,EngineError } from '../src/platform/workflow/flowable.transport';
import { FlowableClient } from '../src/workflow/flowable/flowable.client';

describe('Generic Flowable transport with explicit response doubles',()=>{
  let transport:FlowableTransport;
  let fetchMock:jest.SpyInstance;
  let previous:NodeJS.ProcessEnv;
  beforeEach(()=>{
    previous={...process.env};
    Object.assign(process.env,{FLOWABLE_URL:'http://engine.test/service',FLOWABLE_USERNAME:'synthetic',FLOWABLE_PASSWORD:'synthetic',FLOWABLE_TIMEOUT_MS:'1000'});
    delete process.env.FLOWABLE_PROCESS_KEY;
    transport=new FlowableTransport();
    fetchMock=jest.spyOn(global,'fetch');
  });
  afterEach(()=>{fetchMock.mockRestore();process.env=previous;});
  it('starts a generic definition with exact string/boolean variables and no business fields',async()=>{
    fetchMock.mockResolvedValue(new Response(JSON.stringify({id:'process-1'})));
    expect(await transport.start('definition-7','subject-ref',{value:'9007199254740993.01',enabled:true})).toEqual({id:'process-1'});
    const [url,request]=fetchMock.mock.calls[0];
    expect(url).toBe('http://engine.test/service/runtime/process-instances');
    expect(JSON.parse(request.body)).toEqual({processDefinitionId:'definition-7',businessKey:'subject-ref',variables:[
      {name:'value',value:'9007199254740993.01',type:'string'}, {name:'enabled',value:true,type:'boolean'},
    ]});
  });
  it('distinguishes safe reads/refused writes from ambiguous failed dispatch',async()=>{
    fetchMock.mockResolvedValueOnce(new Response('',{status:503}));
    await expect(transport.task('task-1')).rejects.toMatchObject({retrySafe:true});
    fetchMock.mockResolvedValueOnce(new Response('',{status:503}));
    await expect(transport.complete('task-1','ACCEPT','op-1')).rejects.toMatchObject({retrySafe:false});
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('refused'),{cause:{code:'ECONNREFUSED'}}));
    await expect(transport.claim('task-1','subject-1')).rejects.toMatchObject({retrySafe:true});
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(transport.claim('task-1','subject-1')).rejects.toMatchObject({retrySafe:false});
  });
  it('does not treat truncated history as an empty/complete result',async()=>{
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({data:[],total:1})));
    await expect(transport.processes('subject-ref')).rejects.toBeInstanceOf(EngineError);
  });
  it('preserves the business adapter process-key guard on inherited operations',async()=>{
    process.env.FLOWABLE_PROCESS_KEY='different-definition';
    await expect(new FlowableClient().start('definition-7','subject-ref',{})).rejects.toMatchObject({retrySafe:true});
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({id:'process-2'})));
    expect(await transport.start('definition-7','subject-ref',{})).toEqual({id:'process-2'});
  });
});
