/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { CommandIdentity } from '../../../platform/evidence/evidence.repository';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { checksum, contextValid } from '../../../platform/evidence/file-safety';
import { IngressOperation, SourceEvent, SourceObservation, SourceRegistration } from './ingress.types';
import { PreviousSensorObservation } from './ingress-reconciliation';
import { ReceivingSensorData } from './ingress.types';
export interface IngressStore {
  accept(context: EvidenceContext, source: SourceRegistration, parsed: { event: SourceEvent; rawHash: string; contentHash: string }, bytes: Buffer, command: CommandIdentity, receivedAt: string, correlationId?: string): Promise<IngressOperation>;
  read(context: EvidenceContext, id: string): Promise<SourceObservation | undefined>;
  operation(context: EvidenceContext, id: string): Promise<SourceObservation | undefined>;
  bytes(context: EvidenceContext, record: SourceObservation): Promise<Buffer>;
  candidate(context: EvidenceContext, at: string): Promise<string | undefined>;
  change<T>(context: EvidenceContext, id: string, work: (record: SourceObservation, client: PoolClient) => Promise<T>): Promise<T>;
  previousSensor(client: PoolClient, context: EvidenceContext, record: SourceObservation): Promise<PreviousSensorObservation | undefined>;
}
export class PostgresIngressStore implements IngressStore {
  constructor(private readonly db: Pick<DatabaseService, 'query' | 'transaction'>) {}
  async read(context: EvidenceContext, id: string) {
    return (await this.db.query('SELECT data FROM openresolve_source_observations WHERE tenant_id=$1 AND id=$2', [context.tenantId, id])).rows[0]?.data;
  }
  async operation(context: EvidenceContext, id: string) {
    return (await this.db.query("SELECT data FROM openresolve_source_observations WHERE tenant_id=$1 AND data->'operation'->>'id'=$2", [context.tenantId, id])).rows[0]?.data;
  }
  async bytes(context: EvidenceContext, record: SourceObservation): Promise<Buffer> {
    if (record.tenantId !== context.tenantId) fail('NOT_FOUND', 404);
    const row = (await this.db.query(`SELECT raw_bytes FROM openresolve_source_receipts WHERE tenant_id=$1 AND source_id=$2 AND source_event_id=$3 AND raw_hash=$4 AND observation_id=$5`,
      [context.tenantId, record.sourceId, record.event.source_event_id, record.rawHash, record.id])).rows[0];
    if (!row || !Buffer.isBuffer(row.raw_bytes) || checksum(row.raw_bytes) !== record.rawHash) fail('CHECKSUM_MISMATCH', 422);
    return row.raw_bytes;
  }
  async candidate(context: EvidenceContext, at: string) {
    return (await this.db.query(`SELECT id FROM openresolve_source_observations WHERE tenant_id=$1 AND data->'operation'->>'state' IN ('PENDING','RUNNING')
      AND (data->'lease'->>'until' IS NULL OR (data->'lease'->>'until')::timestamptz<=$2)
      AND (data->>'nextAttemptAt' IS NULL OR (data->>'nextAttemptAt')::timestamptz<=$2) ORDER BY received_at,id LIMIT 1`, [context.tenantId, at])).rows[0]?.id;
  }
  async previousSensor(client: PoolClient, context: EvidenceContext, record: SourceObservation): Promise<PreviousSensorObservation | undefined> {
    const event = record.event.data as ReceivingSensorData;
    const previous = (await client.query(`SELECT data FROM openresolve_source_observations WHERE tenant_id=$1 AND source_id=$2 AND id<>$3
      AND data->>'kind'='RECEIVING_SENSOR' AND data->'operation'->>'state'='SUCCEEDED'
      AND (data->'outcome'->>'reason') IS DISTINCT FROM 'SOURCE_CONFLICT'
      AND data->'event'->'data'->>'device_id'=$4 AND data->'event'->'data'->>'external_order_id'=$5 AND data->'event'->'data'->>'external_item_id'=$6
      ORDER BY (data->'event'->'data'->>'sequence')::bigint DESC,received_at DESC,id DESC LIMIT 1`,
      [context.tenantId, record.sourceId, record.id, event.device_id, event.external_order_id, event.external_item_id])).rows[0]?.data as SourceObservation;
    if (!previous) return;
    const data = previous.event.data as ReceivingSensorData;
    return { deviceId: data.device_id, sequence: data.sequence, quantity: data.received_quantity, quality: data.quality, observedAt: previous.event.observed_at };
  }
  async accept(context: EvidenceContext, source: SourceRegistration, parsed: { event: SourceEvent; rawHash: string; contentHash: string }, bytes: Buffer, command: CommandIdentity, receivedAt: string, correlationId?: string): Promise<IngressOperation> {
    contextValid(context);
    if (source.tenantId !== context.tenantId || source.principal !== context.subject || !source.active || checksum(bytes) !== parsed.rawHash) fail('FORBIDDEN', 403);
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='15s'"); await client.query("SET LOCAL lock_timeout='5s'");
      const currentSource = (await client.query('SELECT principal,kind,active,simulated FROM openresolve_connector_sources WHERE tenant_id=$1 AND id=$2 FOR SHARE', [context.tenantId, source.id])).rows[0];
      if (!currentSource || currentSource.principal !== context.subject || !currentSource.active || currentSource.kind !== source.kind) fail('FORBIDDEN', 403);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['connector-command:' + command.scope]);
      const saved = (await client.query('SELECT request_hash,observation_id,response FROM openresolve_connector_commands WHERE tenant_id=$1 AND scope_hash=$2', [context.tenantId, command.scope])).rows[0];
      if (saved && saved.request_hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['connector-event:' + context.tenantId + ':' + source.id + ':' + parsed.event.source_event_id]);
      const matching = (await client.query(`SELECT data FROM openresolve_source_observations WHERE tenant_id=$1 AND source_id=$2 AND source_event_id=$3 AND content_hash=$4 FOR UPDATE`,
        [context.tenantId, source.id, parsed.event.source_event_id, parsed.contentHash])).rows[0]?.data as SourceObservation;
      let record = matching;
      if (!record) {
        if (saved) throw new Error('Connector cached command lost its immutable observation.');
        const anchor = (await client.query('SELECT observation_id FROM openresolve_source_event_anchors WHERE tenant_id=$1 AND source_id=$2 AND source_event_id=$3', [context.tenantId, source.id, parsed.event.source_event_id])).rows[0];
        const id = randomUUID(), operation: IngressOperation = { id: randomUUID(), tenant_id: context.tenantId, kind: 'CONNECTOR_INGRESS', state: 'PENDING', created_at: receivedAt, updated_at: receivedAt,
          resource_ref: { pack_id: 'openresolve', type: 'source-observation', id } };
        record = { id, tenantId: context.tenantId, sourceId: source.id, kind: source.kind, requestedBy: context.subject, simulated: currentSource.simulated,
          event: parsed.event, rawHash: parsed.rawHash, contentHash: parsed.contentHash, receivedAt, operation,
          acknowledgement: { ...operation, resource_ref: { ...operation.resource_ref } }, attempts: 0, witnessVersion: 'source-witness-xml-v1', correlationId: correlationId || randomUUID(),
          ...(anchor ? { originalObservationId: anchor.observation_id } : {}) };
        await client.query('INSERT INTO openresolve_source_observations(tenant_id,id,source_id,source_event_id,content_hash,received_at,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [context.tenantId, id, source.id, parsed.event.source_event_id, parsed.contentHash, receivedAt, JSON.stringify(record)]);
        if (!anchor) await client.query('INSERT INTO openresolve_source_event_anchors(tenant_id,source_id,source_event_id,observation_id) VALUES($1,$2,$3,$4)', [context.tenantId, source.id, parsed.event.source_event_id, id]);
      }
      if (saved && saved.observation_id !== record.id) throw new Error('Connector command scope mismatch.');
      await client.query(`INSERT INTO openresolve_source_receipts(tenant_id,source_id,source_event_id,raw_hash,observation_id,received_at,raw_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,source_id,source_event_id,raw_hash) DO NOTHING`, [context.tenantId, source.id, parsed.event.source_event_id, parsed.rawHash, record.id, receivedAt, bytes]);
      const receipt = (await client.query('SELECT raw_bytes,observation_id FROM openresolve_source_receipts WHERE tenant_id=$1 AND source_id=$2 AND source_event_id=$3 AND raw_hash=$4', [context.tenantId, source.id, parsed.event.source_event_id, parsed.rawHash])).rows[0];
      if (receipt?.observation_id !== record.id || !Buffer.isBuffer(receipt?.raw_bytes) || !receipt.raw_bytes.equals(bytes)) throw new Error('Connector durable raw-byte readback mismatch.');
      const response = saved?.response || record.acknowledgement;
      if (!saved) await client.query('INSERT INTO openresolve_connector_commands(tenant_id,scope_hash,request_hash,observation_id,response) VALUES($1,$2,$3,$4,$5::jsonb)', [context.tenantId, command.scope, command.hash, record.id, JSON.stringify(response)]);
      return response;
    });
  }
  async change<T>(context: EvidenceContext, id: string, work: (record: SourceObservation, client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='15s'"); await client.query("SET LOCAL lock_timeout='5s'");
      const before = (await client.query('SELECT source_id,source_event_id FROM openresolve_source_observations WHERE tenant_id=$1 AND id=$2', [context.tenantId, id])).rows[0];
      if (!before) fail('NOT_FOUND', 404);
      // Source configuration precedes event locks in acceptance and worker transactions.
      await client.query('SELECT id FROM openresolve_connector_sources WHERE tenant_id=$1 AND id=$2 FOR SHARE', [context.tenantId, before.source_id]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['connector-event:' + context.tenantId + ':' + before.source_id + ':' + before.source_event_id]);
      const record = (await client.query('SELECT data FROM openresolve_source_observations WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, id])).rows[0]?.data as SourceObservation;
      if (!record) fail('NOT_FOUND', 404);
      if (record.kind === 'RECEIVING_SENSOR') {
        const data = record.event.data as ReceivingSensorData;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['connector-device:' + JSON.stringify([context.tenantId, record.sourceId, data.device_id, data.external_order_id, data.external_item_id])]);
      }
      const result = await work(record, client);
      if (record.id !== id || record.tenantId !== context.tenantId || record.sourceId !== before.source_id || record.event.source_event_id !== before.source_event_id) throw new Error('Connector update scope mismatch.');
      await client.query('UPDATE openresolve_source_observations SET data=$3::jsonb WHERE tenant_id=$1 AND id=$2', [context.tenantId, id, JSON.stringify(record)]); return result;
    });
  }
}
