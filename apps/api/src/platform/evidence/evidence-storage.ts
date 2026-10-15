/* SPDX-License-Identifier: MIT */
import { EvidenceContext, EvidenceStorage, fail } from './evidence.types';
import { contextValid, UUID } from './file-safety';
export interface PrivateObjectStore {
  upload(key: string, bytes: Buffer, mediaType: string, checksum: string): Promise<void>;
  read(key: string): Promise<AsyncIterable<Buffer>>;
}
export class PrivateEvidenceStorage implements EvidenceStorage {
  constructor(private readonly storage: PrivateObjectStore) {}
  private check(context: EvidenceContext, key: string): void {
    contextValid(context);
    const parts = key.split('/');
    if (parts.length !== 8 || parts[0] !== 'tenant' || parts[1] !== context.tenantId || parts[2] !== 'evidence' ||
      !UUID.test(parts[3]) || parts[4] !== 'revision' || !/^[1-9][0-9]*$/.test(parts[5]) ||
      parts[6] !== 'content' || !UUID.test(parts[7])) fail('FORBIDDEN', 403);
  }
  async put(context: EvidenceContext, key: string, bytes: Buffer, mediaType: string, hash: string): Promise<void> {
    this.check(context, key); await this.storage.upload(key, bytes, mediaType, hash);
  }
  async read(context: EvidenceContext, key: string): Promise<AsyncIterable<Buffer>> {
    this.check(context, key); return this.storage.read(key);
  }
}
