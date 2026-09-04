import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1788487140225 implements MigrationInterface {
    name = 'InitialSchema1788487140225'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "issuance_record" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "payment_ref" text NOT NULL, "epoch" text NOT NULL, "bundle_count" integer NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3f7b4fd9dfd4bbf85fa76b9c179" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_80132d844592ff164513323494" ON "issuance_record" ("payment_ref") `);
        await queryRunner.query(`CREATE INDEX "IDX_8442ac1921111ea961d4bb0aa7" ON "issuance_record" ("epoch") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_8442ac1921111ea961d4bb0aa7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_80132d844592ff164513323494"`);
        await queryRunner.query(`DROP TABLE "issuance_record"`);
    }

}
