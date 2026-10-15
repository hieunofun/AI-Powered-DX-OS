/* SPDX-License-Identifier: MIT */
import { createServer, Socket } from 'node:net';
import { ClamavScanner } from './clamav.scanner';
describe('ClamAV INSTREAM protocol (real TCP, scripted daemon)', () => {
  let close: () => Promise<void>;
  const now = Date.now();
  const version = (timestamp = now, engine = '1.4.6') => 'ClamAV ' + engine + '/12345/' + new Date(timestamp).toUTCString().replace('GMT', '').trim();
  async function scanner(reply: (socket: Socket, command: string, bytes: Buffer) => void, timeoutMs = 200, versionReply = version()) {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
      let buffer = Buffer.alloc(0), command: string, content = Buffer.alloc(0);
      socket.on('data', bytes => {
        buffer = Buffer.concat([buffer, bytes]);
        if (!command) {
          const end = buffer.indexOf(0); if (end < 0) return;
          command = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 1);
          if (command === 'zVERSION') { socket.end(versionReply + '\0'); return; }
          expect(command).toBe('zINSTREAM');
        }
        if (command !== 'zINSTREAM') return;
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(); if (buffer.length < length + 4) return;
          if (length === 0) { reply(socket, command, content); buffer = Buffer.alloc(0); return; }
          content = Buffer.concat([content, buffer.subarray(4, length + 4)]); buffer = buffer.subarray(length + 4);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
    return new ClamavScanner({ host: '127.0.0.1', port: (server.address() as any).port, timeoutMs, freshnessMs: 86400000, engine: '1.4.6' }, () => now);
  }
  afterEach(async () => { if (close) await close(); close = undefined; });
  test('fragments and full chunk framing preserve exact bytes and provenance', async () => {
    const content = Buffer.alloc(150000, 65);
    const client = await scanner((socket, _command, bytes) => {
      expect(bytes.equals(content)).toBe(true); socket.write('stream: '); setTimeout(() => socket.end('OK\0'), 5);
    });
    expect(await client.scan(content)).toMatchObject({ state: 'CLEAN', retryable: false, engine: '1.4.6', definitions: '12345' });
  });
  test.each(['Eicar-Signature', 'Win.Test.Agent'])('%s is infected, never clean', async signature => {
    const client = await scanner(socket => socket.end('stream: ' + signature + ' FOUND\0'));
    expect(await client.scan(Buffer.from('fixture'))).toMatchObject({ state: 'INFECTED', reason: signature, retryable: false });
  });
  test.each(['Heuristics.Limits.Exceeded.MaxScanSize', 'Heuristics.Encrypted.PDF', 'Heuristics.Broken.Executable'])('%s blocks incomplete scan permanently', async signature => {
    const client = await scanner(socket => socket.end('stream: ' + signature + ' FOUND\0'));
    expect(await client.scan(Buffer.from('fixture'))).toMatchObject({ state: 'SCAN_FAILED', retryable: false });
  });
  test.each(['stream: OK', 'stream: OK\0\0', 'stream: OK\n\0', 'stream: Access denied ERROR\0', 'x'.repeat(8193) + '\0', 'OK\0'])('rejects incomplete or invalid reply', async response => {
    const client = await scanner(socket => socket.end(response));
    expect((await client.scan(Buffer.from('fixture'))).state).toBe('SCAN_FAILED');
  });
  test('does not publish early OK followed by another packet', async () => {
    const client = await scanner(socket => { socket.write('stream: OK\0'); setTimeout(() => socket.end('stream: Eicar-Signature FOUND\0'), 5); });
    expect((await client.scan(Buffer.from('fixture'))).state).toBe('SCAN_FAILED');
  });
  test('socket deadline blocks even after a complete record without EOF', async () => {
    const client = await scanner(socket => socket.write('stream: OK\0'), 30);
    expect(await client.scan(Buffer.from('fixture'))).toMatchObject({ state: 'SCAN_FAILED', retryable: true });
  });
  test.each([version(now - 86401000), version(now + 301000), version(now, '9.0.0'), 'ClamAV invalid'])('unready engine/definitions prevents scan dispatch', async response => {
    const dispatch = jest.fn(); const client = await scanner(dispatch, 200, response);
    expect((await client.scan(Buffer.from('fixture'))).state).toBe('SCAN_FAILED'); expect(dispatch).not.toHaveBeenCalled();
  });
});
