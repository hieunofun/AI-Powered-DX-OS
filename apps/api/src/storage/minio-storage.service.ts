import { Injectable } from '@nestjs/common';
import { Client } from 'minio';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

@Injectable()
export class MinioStorageService {
  readonly bucket = process.env.MINIO_BUCKET_INVOICES || 'invoices';
  private readonly client: Client;
  constructor() {
    const useSSL = process.env.MINIO_USE_SSL || 'false';
    if (!['true', 'false'].includes(useSSL)) throw new Error('MINIO_USE_SSL must be true or false.');
    const port = Number(process.env.MINIO_PORT || '9000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MINIO_PORT.');
    this.client = new Client({
      endPoint: process.env.MINIO_ENDPOINT || 'localhost', port, useSSL: useSSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'minio_dev_only',
      secretKey: process.env.MINIO_SECRET_KEY || 'minio_dev_password_only',
    });
    this.client.setRequestOptions({ agent: useSSL === 'true'
      ? new HttpsAgent({ timeout: 15000 }) : new HttpAgent({ timeout: 15000 }) });
  }
  async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) {
      try { await this.client.makeBucket(this.bucket); } catch (error) {
        // Multiple API instances may initialize the bucket simultaneously.
        if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.code)) throw error;
        if (!(await this.client.bucketExists(this.bucket))) throw error;
      }
    }
    try {
      const policy = await this.client.getBucketPolicy(this.bucket);
      // Fail closed for provisioned buckets with any resource policy. Permissions
      // belong to scoped IAM identities; ingestion never changes bucket policy.
      if (policy && policy.trim()) throw new Error('Invoice bucket must have no resource policy.');
    } catch (error) {
      if (error.code !== 'NoSuchBucketPolicy') throw error;
    }
    // No anonymous policy is created. Provisioned buckets must also remain private.
  }
  async upload(key: string, bytes: Buffer, mediaType: string, checksum: string): Promise<void> {
    await this.ensureBucket();
    await this.client.putObject(this.bucket, key, bytes, bytes.length, { 'Content-Type': mediaType, sha256: checksum });
    const stat = await this.stat(key);
    if (stat.metaData.sha256 !== checksum || stat.size !== bytes.length) throw new Error('Stored object integrity check failed.');
  }
  stat(key: string) { return this.client.statObject(this.bucket, key); }
  read(key: string) { return this.client.getObject(this.bucket, key); }
  delete(key: string) { return this.client.removeObject(this.bucket, key); }
}
