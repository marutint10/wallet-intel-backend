import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShareIdToTokenAnalyses1779733773596 implements MigrationInterface {
  name = 'AddShareIdToTokenAnalyses1779733773596';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "token_analyses"
      ADD COLUMN IF NOT EXISTS "share_id" character varying(12)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_token_analyses_share_id"
      ON "token_analyses" ("share_id")
      WHERE "share_id" IS NOT NULL
    `);

    await queryRunner.query(`
      UPDATE "token_analyses"
      SET "share_id" = LOWER(SUBSTRING(MD5(RANDOM()::TEXT), 1, 12))
      WHERE "share_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_token_analyses_share_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "token_analyses"
      DROP COLUMN IF EXISTS "share_id"
    `);
  }
}
