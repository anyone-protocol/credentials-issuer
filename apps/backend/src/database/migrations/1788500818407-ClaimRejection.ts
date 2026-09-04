import { MigrationInterface, QueryRunner } from "typeorm";

export class ClaimRejection1788500818407 implements MigrationInterface {
    name = 'ClaimRejection1788500818407'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "claim_rejection" ("reason" text NOT NULL, "count" bigint NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_71fe3e8d13c64d5d8e0e1f829c3" PRIMARY KEY ("reason"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "claim_rejection"`);
    }

}
