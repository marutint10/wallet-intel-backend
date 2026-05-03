import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'wallet_known_tokens' })
@Index('IDX_wallet_known_tokens_chain_wallet_address', [
  'chain_id',
  'wallet_address',
])
@Unique('UQ_wallet_known_tokens_chain_wallet_contract', [
  'chain_id',
  'wallet_address',
  'contract_address',
])
export class WalletKnownTokenEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 42 })
  wallet_address!: string;

  @Column({ type: 'varchar', length: 16, default: 'ethereum' })
  chain_id!: string;

  @Column({ type: 'varchar', length: 42 })
  contract_address!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  symbol!: string | null;

  @Column({ type: 'integer', nullable: true })
  decimals!: number | null;

  @Column({ type: 'timestamptz' })
  first_seen_at!: Date;

  @Column({ type: 'timestamptz' })
  last_seen_at!: Date;

  @Column({ type: 'integer', default: 1 })
  seen_count!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}