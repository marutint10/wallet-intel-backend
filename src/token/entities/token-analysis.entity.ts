import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'token_analyses' })
@Index('idx_token_analyses_contract_chain', ['contractAddress', 'chain'], {
  unique: true,
})
export class TokenAnalysisEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'contract_address', type: 'varchar', length: 64 })
  contractAddress!: string;

  @Column({ type: 'varchar', length: 16 })
  chain!: string;

  @Column({ name: 'token_name', type: 'varchar', length: 128, nullable: true })
  tokenName!: string | null;

  @Column({ name: 'token_symbol', type: 'varchar', length: 32, nullable: true })
  tokenSymbol!: string | null;

  @Column({
    name: 'share_id',
    type: 'varchar',
    length: 12,
    nullable: true,
    unique: true,
  })
  shareId!: string | null;

  @Column({ name: 'total_holders', type: 'integer', nullable: true })
  totalHolders!: number | null;

  @Column({ name: 'holders_data', type: 'jsonb', nullable: true })
  holdersData!: unknown[] | null;

  @Column({ name: 'quality_metrics', type: 'jsonb', nullable: true })
  qualityMetrics!: Record<string, unknown> | null;

  @Column({ name: 'distribution', type: 'jsonb', nullable: true })
  distribution!: Record<string, unknown> | null;

  @Column({ name: 'risk_callouts', type: 'jsonb', nullable: true })
  riskCallouts!: unknown[] | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}