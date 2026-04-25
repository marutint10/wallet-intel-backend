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
@Index('IDX_wallet_known_tokens_wallet_address', ['wallet_address'])
@Unique('UQ_wallet_known_tokens_wallet_address_contract_address', [
  'wallet_address',
  'contract_address',
])
export class WalletKnownTokenEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 42 })
  wallet_address!: string;

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