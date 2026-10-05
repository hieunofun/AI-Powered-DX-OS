import { Client } from 'minio';
import { MinioStorageService } from './minio-storage.service';

jest.mock('minio', () => ({ Client: jest.fn() }));
describe('MinIO adapter (SDK mocked; real acceptance tested separately)', () => {
  let sdk: any, storage: MinioStorageService;
  const checksum = 'a'.repeat(64);
  beforeEach(() => {
    sdk = { setRequestOptions: jest.fn(), bucketExists: jest.fn(async () => true), makeBucket: jest.fn(),
      getBucketPolicy: jest.fn(async () => { throw { code: 'NoSuchBucketPolicy' }; }),
      putObject: jest.fn(), statObject: jest.fn(async () => ({ size: 3, metaData: { sha256: checksum } })) };
    (Client as jest.Mock).mockImplementation(() => sdk);
    storage = new MinioStorageService();
  });
  it('creates a missing bucket and uploads original checksum metadata', async () => {
    sdk.bucketExists.mockResolvedValue(false);
    await storage.upload('safe/key.xml', Buffer.from('abc'), 'application/xml', checksum);
    expect(sdk.makeBucket).toHaveBeenCalledWith('invoices');
    expect(sdk.putObject).toHaveBeenCalledWith('invoices', 'safe/key.xml', Buffer.from('abc'), 3,
      { 'Content-Type': 'application/xml', sha256: checksum });
    expect(sdk.statObject).toHaveBeenCalledWith('invoices', 'safe/key.xml');
  });
  it('fails closed for a provisioned public bucket', async () => {
    sdk.getBucketPolicy.mockResolvedValue('{"Statement":[{"Principal":"*","Effect":"Allow"}]}');
    await expect(storage.upload('key', Buffer.from('abc'), 'application/xml', checksum)).rejects.toThrow();
    expect(sdk.putObject).not.toHaveBeenCalled();
  });
  it('rejects mismatched checksum metadata after upload', async () => {
    sdk.statObject.mockResolvedValue({ size: 3, metaData: { sha256: 'b'.repeat(64) } });
    await expect(storage.upload('key', Buffer.from('abc'), 'application/xml', checksum)).rejects.toThrow('integrity');
  });
  it('rejects a stored size mismatch', async () => {
    sdk.statObject.mockResolvedValue({ size: 2, metaData: { sha256: checksum } });
    await expect(storage.upload('key', Buffer.from('abc'), 'application/xml', checksum)).rejects.toThrow('integrity');
  });
});
