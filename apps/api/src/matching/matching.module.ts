import { Module } from '@nestjs/common';
import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';
import { MatchingRepository } from './matching.repository';
@Module({ controllers: [MatchingController], providers: [MatchingRepository, MatchingService] })
export class MatchingModule {}
