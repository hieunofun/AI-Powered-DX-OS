import { PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface DataPort {
  query<T extends QueryResultRow = any>(text:string,params?:any[]):Promise<QueryResult<T>>;
  getClient():Promise<PoolClient>;
  transaction<T>(callback:(client:PoolClient)=>Promise<T>):Promise<T>;
}
