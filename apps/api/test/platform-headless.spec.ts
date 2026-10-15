import { Test } from '@nestjs/testing';
import { PlatformModule,AuthService,DatabaseService,FlowableTransport,JwtAuthGuard,RolesGuard } from '../src/platform';
import { AuthService as LegacyAuth } from '../src/auth/auth.service';
import { DatabaseService as LegacyData } from '../src/database/database.service';
import { JwtAuthGuard as LegacyJwt } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard as LegacyRoles } from '../src/auth/guards/roles.guard';
import { PurchaseOrdersService } from '../src/purchase-orders/purchase-orders.service';
import { WorkflowService } from '../src/workflow/workflow.service';

describe('Headless platform composition (DI smoke; no external service acceptance)',()=>{
  it('boots its real providers without business modules and retains legacy token identities',async()=>{
    const module=await Test.createTestingModule({imports:[PlatformModule]}).compile();
    try {
      expect(module.get(AuthService)).toBeInstanceOf(AuthService);
      expect(module.get(DatabaseService)).toBeInstanceOf(DatabaseService);
      expect(module.get(FlowableTransport)).toBeInstanceOf(FlowableTransport);
      expect(module.get(JwtAuthGuard)).toBeInstanceOf(JwtAuthGuard);
      expect(module.get(RolesGuard)).toBeInstanceOf(RolesGuard);
      expect(LegacyAuth).toBe(AuthService);
      expect(LegacyData).toBe(DatabaseService);
      expect(LegacyJwt).toBe(JwtAuthGuard);
      expect(LegacyRoles).toBe(RolesGuard);
      expect(()=>module.get(PurchaseOrdersService)).toThrow();
      expect(()=>module.get(WorkflowService)).toThrow();
    } finally { await module.close(); }
  });
});
