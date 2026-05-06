import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'whale_snapshots' })
@Index('idx_whale_snapshots_contract_wallet_snapshot', [
  'contractAddress',
  'walletAddress',
  'snapshotAt',
])
export class WhaleSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'contract_address', type: 'varchar', length: 64 })
  contractAddress!: string;

  @Column({ name: 'wallet_address', type: 'varchar', length: 64 })
  walletAddress!: string;

  @Column({ type: 'decimal', precision: 36, scale: 18 })
  balance!: string;

  @Column({
    name: 'usd_value',
    type: 'decimal',
    precision: 18,
    scale: 2,
    nullable: true,
  })
  usdValue!: string | null;

  @Column({
    name: 'snapshot_at',
    type: 'timestamp',
    default: () => 'NOW()',
  })
  snapshotAt!: Date;
}
