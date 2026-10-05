// Runs inside the real API container. No storage/database mocks.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Client } = require('minio');
const { Pool } = require('pg');

(async () => {
  const expected = JSON.parse(process.env.EXPECTED_HASHES);
  const bucket = process.env.MINIO_BUCKET_INVOICES || 'invoices';
  const port = Number(process.env.MINIO_PORT || '9000');
  const endpoint = process.env.MINIO_ENDPOINT;
  const secure = process.env.MINIO_USE_SSL === 'true';
  const minio = new Client({ endPoint: endpoint, port, useSSL: secure,
    accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY });
  const db = new Pool({ host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT),
    database: process.env.POSTGRES_DB, user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD });
  try {
    const { rows } = await db.query('SELECT * FROM invoice_files WHERE ingestion_id=$1 ORDER BY file_kind', [process.env.INGESTION_ID]);
    assert.equal(rows.length, Object.keys(expected).length);
    for (const row of rows) {
      assert.equal(row.sha256, expected[row.file_kind]);
      assert.match(row.object_key, /^invoices\/\d{4}\/\d{2}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(xml|pdf)$/);
      assert.equal(row.object_key.includes('..'), false);
      const stat = await minio.statObject(bucket, row.object_key);
      assert.equal(stat.metaData.sha256, row.sha256);
      assert.equal(String(stat.size), row.size_bytes);
      const stream = await minio.getObject(bucket, row.object_key);
      const digest = createHash('sha256');
      for await (const chunk of stream) digest.update(chunk);
      assert.equal(digest.digest('hex'), row.sha256);
      const url = `${secure ? 'https' : 'http'}://${endpoint}:${port}/${bucket}/${row.object_key}`;
      const anonymous = await fetch(url);
      assert.equal(anonymous.status, 403, 'Invoice bucket must deny anonymous reads');
      await anonymous.arrayBuffer();
      for (const other of await minio.listBuckets()) {
        if (other.name === bucket) continue;
        await assert.rejects(minio.statObject(other.name, row.object_key), error => error.code === 'NoSuchKey' || error.code === 'NotFound');
      }
    }
    console.log(`PASS real MinIO: ${rows.length} file(s), fixture/DB/metadata/download SHA-256 equal; private bucket verified.`);
  } finally { await db.end(); }
})().catch(() => { console.error('FAIL real MinIO integrity/private-bucket validation'); process.exitCode = 1; });
