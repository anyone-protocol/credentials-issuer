import { MigrationInterface, QueryRunner } from "typeorm";

export class EpochAccounting1788543407510 implements MigrationInterface {
    name = 'EpochAccounting1788543407510'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "epoch_counter" ("epoch" text NOT NULL, "bundle_size" integer NOT NULL, "bundles_paid" bigint NOT NULL, "signatures_issued" bigint NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_76c339bbcf808e0afa3bc86862e" PRIMARY KEY ("epoch"))`);
        await queryRunner.query(`CREATE TABLE "reconciliation_alarm" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "epoch" text NOT NULL, "kind" text NOT NULL, "expected" bigint NOT NULL, "actual" bigint NOT NULL, "delta" bigint NOT NULL, "raised_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_2219eace8a5dd694d7d1c293f0c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_97d596a3507042d5f47ae612a0" ON "reconciliation_alarm" ("epoch") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_97d596a3507042d5f47ae612a0"`);
        await queryRunner.query(`DROP TABLE "reconciliation_alarm"`);
        await queryRunner.query(`DROP TABLE "epoch_counter"`);
    }

}
