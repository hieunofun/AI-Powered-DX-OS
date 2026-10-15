/* SPDX-License-Identifier: MIT */
import { DynamicModule, Module } from '@nestjs/common';
import { EvidenceGuard, EvidenceErrorFilter } from '../../platform/evidence/evidence.controller';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from '../../platform/evidence/evidence-context';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
@Module({})
export class OnboardingModule {
  // Explicit composition only. Owning SDK/identity/decision adapters must be provided by the host.
  static register(service: OnboardingService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('Verified current identity and onboarding service are required.');
    return { module: OnboardingModule, controllers: [OnboardingController], providers: [
      { provide: OnboardingService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver }, EvidenceGuard, EvidenceErrorFilter,
    ], exports: [OnboardingService] };
  }
}
