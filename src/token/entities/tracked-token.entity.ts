import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'tracked_tokens' })
export class TrackedTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'contract_address', type: 'varchar', length: 64 })
  contractAddress!: string;

  @Column({ type: 'varchar', length: 16 })
  chain!: string;

  @Column({ name: 'token_name', type: 'varchar', length: 128, nullable: true })
  tokenName!: string | null;

  @Column({ name: 'token_symbol', type: 'varchar', length: 16, nullable: true })
  tokenSymbol!: string | null;

  @Column({ name: 'telegram_chat_id', type: 'varchar', length: 64, nullable: true })
  telegramChatId!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
