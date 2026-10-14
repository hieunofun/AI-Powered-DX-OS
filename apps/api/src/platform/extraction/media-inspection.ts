/* SPDX-License-Identifier: MIT */
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { ExtractionField } from '../../ai/extraction/extraction-provider';
import { fail } from '../evidence/evidence.types';
export interface DocumentText {
  parser: 'pdfjs-dist@6.4.299'; pages: { page: number; text: string }[];
}
export function imageBudget(bytes: Buffer, media: 'image/png' | 'image/jpeg'): void {
  const dimensions = (width: number, height: number) => {
    if (!width || !height || width > 20000 || height > 20000 || width * height > 25000000) fail('DRAFT_INVALID', 422);
  };
  if (media === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') fail('DRAFT_INVALID', 422);
    dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)); return;
  }
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) fail('DRAFT_INVALID', 422);
  let offset = 2, segments = 0;
  while (offset + 4 <= bytes.length && ++segments <= 1024) {
    if (bytes[offset++] !== 0xff) fail('DRAFT_INVALID', 422);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 1) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail('DRAFT_INVALID', 422);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || bytes[offset + 2] !== 8) fail('DRAFT_INVALID', 422);
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)); return;
    }
    offset += length;
  }
  fail('DRAFT_INVALID', 422);
}
const parserWorker = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let task;
  try {
    const pdf = await import(workerData.moduleUrl);
    let exceeded = false;
    console.log = (...args) => { if (args.some(value => /Image exceeded maximum allowed resolution|Max.*(?:image|pixel)/i.test(String(value)))) exceeded = true; };
    task = pdf.getDocument({ data: new Uint8Array(workerData.bytes), isEvalSupported: false, enableXfa: false,
      disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, maxImageSize: 25000000, verbosity: 1,
      stopAtErrors: true, isImageDecoderSupported: false, isOffscreenCanvasSupported: false });
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > 30) throw new Error();
    const pages = []; let characters = 0, pixels = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index), viewport = page.getViewport({scale: 150 / 72});
      const area = viewport.width * viewport.height;
      if (!Number.isFinite(area) || viewport.width <= 0 || viewport.height <= 0 || area > 25000000 || (pixels += area) > 100000000) throw new Error();
      const operators = await page.getOperatorList();
      if (exceeded || operators.fnArray.length > 100000) throw new Error();
      for (let i = 0; i < operators.fnArray.length; i++) {
        if (operators.fnArray[i] === pdf.OPS.paintImageXObject) {
          const args = operators.argsArray[i];
          if (!Number.isSafeInteger(args[1]) || !Number.isSafeInteger(args[2]) || args[1] * args[2] > 25000000) throw new Error();
        }
      }
      const content = await page.getTextContent();
      const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\\n' : ' ')).join('');
      characters += Array.from(text).length; if (characters > 200000) throw new Error();
      pages.push({page:index,text}); page.cleanup();
    }
    parentPort.postMessage({ok:true,pages});
  } catch { parentPort.postMessage({ok:false}); }
  finally { if (task) await task.destroy().catch(() => undefined); }
})();
`;
export async function inspectPdf(bytes: Buffer, timeoutMs = 10000): Promise<DocumentText> {
  if (bytes.length > 20971520 || !/^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) fail('DRAFT_INVALID', 422);
  const moduleUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
  return new Promise<DocumentText>((resolve, reject) => {
    const worker = new Worker(parserWorker, { eval: true, workerData: { moduleUrl, bytes }, env: {},
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    let ended = false;
    const finish = (result?: DocumentText) => {
      if (ended) return; ended = true; clearTimeout(timer); void worker.terminate();
      result ? resolve(result) : reject(new Error('Bounded PDF validation failed.'));
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    worker.once('message', value => finish(value?.ok === true && Array.isArray(value.pages) ? { parser: 'pdfjs-dist@6.4.299', pages: value.pages } : undefined));
    worker.once('error', () => finish()); worker.once('exit', () => finish());
  }).catch(() => fail('DRAFT_INVALID', 422));
}
export function groundedFields(fields: ExtractionField[], evidenceId: string, document?: DocumentText): ExtractionField[] {
  if (!document) return fields;
  return fields.map(field => {
    if (field.status !== 'EXTRACTED') return field;
    const candidates: { page: number; start: number; end: number }[] = [];
    for (const page of document.pages) {
      let start = page.text.indexOf(field.value);
      while (start !== -1) {
        const end = start + field.value.length;
        const boundary = field.kind === 'DECIMAL' ? /[0-9.]/ : /[\p{L}\p{N}]/u;
        if (!boundary.test(page.text[start - 1] || '') && !boundary.test(page.text[end] || '')) candidates.push({ page: page.page,
          start: Array.from(page.text.slice(0, start)).length, end: Array.from(page.text.slice(0, end)).length });
        if (candidates.length > 1) return field;
        start = page.text.indexOf(field.value, start + 1);
      }
    }
    return candidates.length === 1 ? { ...field, source_refs: [{ location_status: 'KNOWN', evidence_id: evidenceId,
      page: candidates[0].page, text_span: { start: candidates[0].start, end: candidates[0].end } }] } : field;
  });
}
