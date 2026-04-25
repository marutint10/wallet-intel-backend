import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { NormalizedTokenAmount } from './wallet.types';

@Entity({ name: 'transactions' })
@Index('IDX_transactions_wallet_address', ['wallet_address'])
@Index('IDX_transactions_transaction_hash', ['transaction_hash'])
@Unique('UQ_transactions_wallet_address_transaction_hash', [
  'wallet_address',
  'transaction_hash',
])
export class TransactionEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 42 })
  wallet_address!: string;

  @Column({ type: 'varchar', length: 66 })
  transaction_hash!: string;

  @Column({ type: 'integer' })
  block_number!: number;

  @Column({ type: 'timestamptz' })
  timestamp!: Date;

  @Column({ type: 'varchar', length: 42 })
  from_address!: string;

  @Column({ type: 'varchar', length: 42, default: '' })
  to_address!: string;

  @Column({
    type: 'enum',
    enum: [
      'transfer',
      'swap',
      'wrap',
      'unwrap',
      'liquidity_add',
      'liquidity_remove',
      'stake',
      'unstake',
      'staking_wrap',
      'staking_unwrap',
      'yield_split',
      'yield_merge',
      'receipt_mint',
      'receipt_burn',
      'protocol_transform',
    ],
  })
  type!:
    | 'transfer'
    | 'swap'
    | 'wrap'
    | 'unwrap'
    | 'liquidity_add'
    | 'liquidity_remove'
    | 'stake'
    | 'unstake'
    | 'staking_wrap'
    | 'staking_unwrap'
    | 'yield_split'
    | 'yield_merge'
    | 'receipt_mint'
    | 'receipt_burn'
    | 'protocol_transform';

  @Column({ type: 'jsonb' })
  inputs!: NormalizedTokenAmount[];

  @Column({ type: 'jsonb' })
  outputs!: NormalizedTokenAmount[];
}