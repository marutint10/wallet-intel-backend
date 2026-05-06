import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'whale_alerts' })
export class WhaleAlertEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'contract_address', type: 'varchar', length: 64 })
  contractAddress!: string;

  @Column({ name: 'wallet_address', type: 'varchar', length: 64 })
  walletAddress!: string;

  @Column({ name: 'alert_type', type: 'varchar', length: 16 })
  alertType!: string;

  @Column({
    name: 'old_balance',
    type: 'decimal',
    precision: 36,
    scale: 18,
    nullable: true,
  })
  oldBalance!: string | null;

  @Column({
    name: 'new_balance',
    type: 'decimal',
    precision: 36,
    scale: 18,
    nullable: true,
  })
  newBalance!: string | null;

  @Column({
    name: 'delta_percent',
    type: 'decimal',
    precision: 8,
    scale: 4,
    nullable: true,
  })
  deltaPercent!: string | null;

  @Column({
    name: 'usd_value_moved',
    type: 'decimal',
    precision: 18,
    scale: 2,
    nullable: true,
  })
  usdValueMoved!: string | null;

  @Column({
    name: 'triggered_at',
    type: 'timestamp',
    default: () => 'NOW()',
  })
  triggeredAt!: Date;

  @Column({ type: 'boolean', default: false })
  delivered!: boolean;
}
