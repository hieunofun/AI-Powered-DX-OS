/* SPDX-License-Identifier: MIT */
import { DynamicModule, Module } from '@nestjs/common';
import { EvidenceService } from './evidence.service';
import { EvidenceController, EvidenceGuard, EvidenceErrorFilter } from './evidence.controller';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from './evidence-context';
@Module({})
export class EvidenceModule {
  static register(service: EvidenceService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('Evidence requires a verified context resolver and authorized service.');
    return { module: EvidenceModule, controllers: [EvidenceController], providers: [
      { provide: EvidenceService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver },
      EvidenceGuard, EvidenceErrorFilter,
    ], exports: [EvidenceService] };
  }
}
