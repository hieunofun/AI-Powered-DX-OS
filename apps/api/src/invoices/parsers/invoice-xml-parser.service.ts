import { Injectable } from '@nestjs/common';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { xmlText } from '../domain/file-validation';
import { IngestionError } from '../domain/ingestion-error';
import { CanonicalInvoiceData } from '../interfaces/invoice.interface';
import { InvoiceXmlParser } from './invoice-xml-parser.interface';
import { SmartProcureInvoiceV1Parser } from './smartprocure-invoice-v1.parser';
import { MatbaoInvoiceV200Parser } from './matbao-invoice-v200.parser';

@Injectable()
export class InvoiceXmlParserService {
  private readonly adapters: InvoiceXmlParser[];
  constructor(projectProfile: SmartProcureInvoiceV1Parser, vietnamProfile: MatbaoInvoiceV200Parser) {
    this.adapters = [projectProfile, vietnamProfile];
  }

  parse(buffer: Buffer): CanonicalInvoiceData {
    const xml = xmlText(buffer);
    // Reject all DTD/entity declarations before invoking any XML library.
    if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) {
      throw new IngestionError('UNSAFE_XML', 'DTD and entity declarations are prohibited.');
    }
    if (/<\?xml[^?]*encoding\s*=\s*['"](?!utf-8['"])[^'"]+['"]/i.test(xml)) {
      throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Only UTF-8 XML encoding is supported.');
    }
    const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    for (const match of markup.matchAll(/&([^;\s<&]+);/g)) {
      const entity = match[1];
      if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(entity)) continue;
      if (!/^#(?:\d+|x[0-9a-fA-F]+)$/.test(entity)) {
        throw new IngestionError('MALFORMED_XML', 'XML contains an undeclared character reference.');
      }
      // Character codepoints are not financial values. Enforce XML 1.0 ranges.
      const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (![9, 10, 13].includes(code) && !(code >= 32 && code <= 0xd7ff) &&
          !(code >= 0xe000 && code <= 0xfffd) && !(code >= 0x10000 && code <= 0x10ffff)) {
        throw new IngestionError('MALFORMED_XML', 'XML contains an invalid character reference.');
      }
    }
    if (XMLValidator.validate(xml) !== true) throw new IngestionError('MALFORMED_XML', 'The uploaded XML is malformed.');
    let document: Record<string, unknown>;
    try {
      document = new XMLParser({ parseTagValue: false, parseAttributeValue: false,
        trimValues: false, ignoreAttributes: false, ignoreDeclaration: true,
        ignorePiTags: true, processEntities: true, allowBooleanAttributes: false }).parse(xml);
    } catch {
      throw new IngestionError('MALFORMED_XML', 'The uploaded XML could not be parsed safely.');
    }
    const adapter = this.adapters.find(candidate => candidate.supports(document));
    if (!adapter) throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'The XML does not use a supported invoice profile.');
    return adapter.parse(document);
  }
}
