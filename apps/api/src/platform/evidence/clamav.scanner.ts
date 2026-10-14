/* SPDX-License-Identifier: MIT */
import { connect } from 'node:net';
import { EvidenceScanner, ScanResult } from './evidence.types';
export interface ClamavOptions { host: string; port: number; timeoutMs: number; freshnessMs: number; engine: string; }
export class ClamavScanner implements EvidenceScanner {
  constructor(private readonly options: ClamavOptions, private readonly now: () => number = Date.now) {
    if (!options.host || /[\s/]/.test(options.host) || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000 ||
      !Number.isSafeInteger(options.freshnessMs) || options.freshnessMs < 1 || options.freshnessMs > 86400000 || !/^\d+\.\d+\.\d+$/.test(options.engine)) {
      throw new Error('Invalid ClamAV scanner configuration.');
    }
  }
  async scan(bytes: Buffer): Promise<ScanResult> {
    const deadline = this.now() + this.options.timeoutMs;
    let provenance: Partial<ScanResult> = {};
    try {
      const version = await this.command('VERSION', undefined, deadline);
      const match = /^ClamAV ([0-9.]+)\/([0-9]+)\/([^\r\n]+)$/.exec(version);
      if (!match || match[1] !== this.options.engine) return { state: 'SCAN_FAILED', reason: 'ENGINE_NOT_READY', retryable: true };
      // The isolated daemon is configured with TZ=UTC; VERSION's ctime lacks a zone.
      const timestamp = Date.parse(match[3] + ' UTC');
      if (!Number.isFinite(timestamp) || timestamp > this.now() + 300000 || this.now() - timestamp > this.options.freshnessMs) {
        return { state: 'SCAN_FAILED', reason: 'STALE_DEFINITIONS', retryable: true };
      }
      provenance = { engine: match[1], definitions: match[2], definitionsAt: new Date(timestamp).toISOString(), policy: 'evidence-intake-v1' };
      const result = await this.command('INSTREAM', bytes, deadline);
      if (result === 'stream: OK') return { ...provenance, state: 'CLEAN', retryable: false };
      const found = /^stream: ([A-Za-z0-9_.:-]{1,180}) FOUND$/.exec(result);
      if (found) {
        const incomplete = /^Heuristics\.(?:Limits\.Exceeded|Encrypted|Broken)/.test(found[1]);
        return { ...provenance, state: incomplete ? 'SCAN_FAILED' : 'INFECTED', reason: found[1], retryable: false };
      }
      return { ...provenance, state: 'SCAN_FAILED', reason: 'SCANNER_PROTOCOL_ERROR', retryable: false };
    } catch {
      return { ...provenance, state: 'SCAN_FAILED', reason: 'SCANNER_UNAVAILABLE_OR_TIMEOUT', retryable: true };
    }
  }
  private command(name: string, bytes: Buffer | undefined, deadline: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      let reply = Buffer.alloc(0), settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket?.destroy();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Scanner deadline.')), Math.max(1, deadline - this.now()));
      socket.on('error', () => finish(new Error('Scanner connection failed.')));
      socket.on('end', () => {
        if (settled) return;
        const end = reply.indexOf(0);
        if (end < 0 || end !== reply.length - 1) finish(new Error('Scanner truncated response.'));
        else finish(undefined, reply.subarray(0, end).toString('utf8'));
      });
      socket.on('data', data => {
        if (reply.length + data.length > 8192) { finish(new Error('Scanner reply limit.')); return; }
        reply = Buffer.concat([reply, data]);
        const end = reply.indexOf(0);
        if (end < 0) return;
        if (end !== reply.length - 1 || reply.subarray(0, end).includes(10) || reply.subarray(0, end).includes(13)) {
          finish(new Error('Invalid scanner frame.')); return;
        }
        // Wait for EOF: a later packet must not append another verdict to OK.
      });
      socket.once('connect', () => {
        const write = async () => {
          async function chunk(value: Buffer): Promise<void> {
            if (settled) throw new Error('Scanner request ended.');
            if (!socket.write(value)) await new Promise<void>((yes, no) => {
              const closed = () => { socket.off('drain', drained); no(new Error('Scanner closed.')); };
              const drained = () => { socket.off('close', closed); yes(); };
              socket.once('drain', drained); socket.once('close', closed);
            });
          }
          await chunk(Buffer.from('z' + name + '\0'));
          if (bytes) {
            if (bytes.length > 20971520) throw new Error('Scanner input limit.');
            for (let offset = 0; offset < bytes.length; offset += 65536) {
              const part = bytes.subarray(offset, offset + 65536), size = Buffer.alloc(4);
              size.writeUInt32BE(part.length); await chunk(size); await chunk(part);
            }
            await chunk(Buffer.alloc(4));
          }
        };
        write().catch(() => finish(new Error('Scanner write failed.')));
      });
    });
  }
}
