import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MatchingRepository } from './matching.repository';
import { UpdateMatchingPolicyDto } from './dto/update-matching-policy.dto';
import { MatchingError } from './matching-error';
@Injectable()
export class MatchingService {
  constructor(private readonly repository: MatchingRepository) {}
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof MatchingError) throw error;
      if (error.code === '23505' && error.constraint === 'uq_match_result_invoice') {
        throw new MatchingError('MATCH_ALREADY_EXISTS', 'This invoice already has a match result.', 409);
      }
      throw new MatchingError('MATCHING_UNAVAILABLE', 'Matching operation could not be completed. No partial changes were committed.', 503);
    }
  }
  match(id: string, actor: AuthenticatedUser) { return this.safe(() => this.repository.match(id, actor)); }
  result(id: string) { return this.safe(() => this.repository.result(id)); }
  invoiceResult(id: string) { return this.safe(() => this.repository.invoiceResult(id)); }
  policy() { return this.safe(() => this.repository.policy()); }
  updatePolicy(dto: UpdateMatchingPolicyDto, actor: AuthenticatedUser) {
    if (!Object.keys(dto).some(key => dto[key] !== undefined)) throw new MatchingError('EMPTY_POLICY_UPDATE', 'At least one tolerance must be supplied.', 400);
    return this.safe(() => this.repository.updatePolicy(dto, actor));
  }
}
