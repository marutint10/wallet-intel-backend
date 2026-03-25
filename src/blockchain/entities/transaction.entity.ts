import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { BlockchainNetwork, BlockchainProvider } from '../interfaces/transaction.interface';

@Entity({ name: 'transactions' })
@Index(['network', 'address'])
@Index(['hash'], { unique: true })
export class TransactionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  network: BlockchainNetwork;

  @Column({ type: 'varchar', length: 32 })
  provider: BlockchainProvider;

  @Column({ type: 'varchar', length: 128 })
  address: string;

  @Column({ type: 'varchar', length: 128 })
  hash: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  blockNumber?: string;

  @Column({ type: 'timestamptz', nullable: true })
  timestamp?: Date;

  @Column({ type: 'varchar', length: 128 })
  fromAddress: string;

  @Column({ type: 'varchar', length: 128 })
  toAddress: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  assetSymbol?: string;

  @Column({ type: 'numeric', nullable: true })
  amount?: string;

  @Column({ type: 'jsonb' })
  raw: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity({ name: 'token_transfers' })
@Index(['transactionHash'])
export class TokenTransferEntity {
  @Column({ type: 'varchar', length: 160, primary: true })
  id: string;

  @Column({ type: 'varchar', length: 128 })
  transactionHash: string;

  @Column({ type: 'varchar', length: 128 })
  walletAddress: string;

  @Column({ type: 'varchar', length: 16 })
  network: BlockchainNetwork;

  @Column({ type: 'varchar', length: 32 })
  provider: BlockchainProvider;

  @Column({ type: 'varchar', length: 128 })
  fromAddress: string;

  @Column({ type: 'varchar', length: 128 })
  toAddress: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  assetSymbol?: string;

  @Column({ type: 'numeric', nullable: true })
  amount?: string;

  @Column({ type: 'int' })
  transferIndex: number;

  @Column({ type: 'jsonb' })
  raw: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity({ name: 'transaction_sync_states' })
@Index(['network', 'address'], { unique: true })
export class TransactionSyncStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  network: BlockchainNetwork;

  @Column({ type: 'varchar', length: 128 })
  address: string;

  @Column({ type: 'varchar', length: 32 })
  provider: BlockchainProvider;

  @Column({ type: 'varchar', length: 128, nullable: true })
  lastSyncedTxHash?: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
