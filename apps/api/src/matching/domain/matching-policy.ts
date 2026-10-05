import Decimal from 'decimal.js';
import { MatchingPolicy } from '../interfaces/matching.interface';
export const RULE_VERSION = '3WM-1.0';
export function snapshotPolicy(policy: MatchingPolicy) {
  return {
    policyCode: policy.policyCode,
    quantityTolerancePercent: new Decimal(policy.quantityTolerancePercent).toFixed(2),
    priceTolerancePercent: new Decimal(policy.priceTolerancePercent).toFixed(2),
    taxTolerancePercent: new Decimal(policy.taxTolerancePercent).toFixed(2),
    totalTolerancePercent: new Decimal(policy.totalTolerancePercent).toFixed(2),
    ruleVersion: RULE_VERSION,
  };
}
