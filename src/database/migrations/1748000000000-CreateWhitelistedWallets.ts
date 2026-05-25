import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWhitelistedWallets1748000000000 implements MigrationInterface {
  name = 'CreateWhitelistedWallets1748000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "whitelisted_wallets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "address" character varying(64) NOT NULL,
        "plan" character varying(16) NOT NULL DEFAULT 'starter',
        "note" text,
        "added_at" TIMESTAMP NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMP,
        CONSTRAINT "UQ_whitelisted_wallets_address" UNIQUE ("address"),
        CONSTRAINT "PK_whitelisted_wallets" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "whitelisted_wallets"
      ADD COLUMN IF NOT EXISTS "plan" character varying(16) NOT NULL DEFAULT 'starter'
    `);

    await queryRunner.query(`
      ALTER TABLE "whitelisted_wallets"
      ADD COLUMN IF NOT EXISTS "note" text
    `);

    await queryRunner.query(`
      ALTER TABLE "whitelisted_wallets"
      ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_whitelisted_wallets_address"
      ON "whitelisted_wallets" ("address")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "whitelisted_wallets"`);
  }
}
