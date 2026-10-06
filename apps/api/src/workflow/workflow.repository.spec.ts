import { WorkflowRepository } from './workflow.repository';
import { DatabaseService } from '../database/database.service';

describe('Workflow operation connection lifecycle',()=>{
  function harness() {
    let borrowed=false;
    const commands:string[]=[];
    const query=jest.fn(async(sql:string)=>{
      commands.push(sql);
      if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
      if(sql.includes('workflow_operations')) return {rows:[{id:'op',approval_case_id:'case',operation:'CLAIM',actor_subject:'actor',actor_roles:['buyer']}]};
      if(sql.includes('approval_cases')) return {rows:[{id:'case'}]};
      if(sql.includes('workflow_policies')) return {rows:[{id:'policy'}]};
      return {rows:[]};
    });
    const client={query,release:jest.fn(()=>{borrowed=false;})};
    // A pool with exactly one connection exposes attempts to borrow another session immediately.
    const db={getClient:jest.fn(async()=>{
      if(borrowed) throw new Error('Pool exhausted');
      borrowed=true; return client;
    }),query:jest.fn(async(sql:string)=>{
      if(borrowed) throw new Error('Pool exhausted');
      return query(sql);
    }),transaction:jest.fn(async()=>{
      if(borrowed) throw new Error('Pool exhausted');
      return 'outside transaction';
    })};
    return {repository:new WorkflowRepository(db as unknown as DatabaseService),db,client,commands};
  }
  it('completes reads, durable dispatch and short transactions with only one pool slot',async()=>{
    const h=harness();
    await expect(h.repository.serialized('op',async()=>{
      await h.repository.operation('op');
      await h.repository.dispatch('op');
      await h.repository.failure('op','ENGINE_UNAVAILABLE',true);
      return 'done';
    })).resolves.toBe('done');
    expect(h.db.getClient).toHaveBeenCalledTimes(1);
    expect(h.db.query).not.toHaveBeenCalled();
    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(h.commands).toContain('BEGIN'); expect(h.commands).toContain('COMMIT');
    expect(h.client.release).toHaveBeenCalledWith(false);
    // The request-local session must not leak into a later unrelated operation.
    await h.repository.pending();
    expect(h.db.query).toHaveBeenCalledTimes(1);
  });
  it('rolls back a local write failure, unlocks the case and releases the only slot',async()=>{
    const h=harness();
    const original=h.client.query.getMockImplementation();
    h.client.query.mockImplementation(async sql=>{
      if(sql.startsWith('UPDATE workflow_operations')) throw new Error('Controlled write failure');
      return original(sql);
    });
    await expect(h.repository.serialized('op',()=>h.repository.failure('op','ENGINE_UNAVAILABLE',true))).rejects.toThrow('Controlled write failure');
    expect(h.commands).toContain('ROLLBACK');
    expect(h.commands.some(sql=>sql.includes('pg_advisory_unlock'))).toBe(true);
    expect(h.client.release).toHaveBeenCalledWith(false);
  });
  it('destroys the session if advisory unlock fails',async()=>{
    const h=harness();
    const original=h.client.query.getMockImplementation();
    h.client.query.mockImplementation(async sql=>{
      if(sql.includes('pg_advisory_unlock')) throw new Error('Lost connection');
      return original(sql);
    });
    await h.repository.serialized('op',async()=>undefined);
    expect(h.client.release).toHaveBeenCalledWith(true);
  });
});

