import { MigrationInterface, QueryRunner } from "typeorm";

export class EntitlementDrip1788559924122 implements MigrationInterface {
    name = 'EntitlementDrip1788559924122'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "entitlement" ("entitlement_id" uuid NOT NULL, "receipt_hash" text NOT NULL, "drip_interval_seconds" integer NOT NULL, "next_drip_at" TIMESTAMP WITH TIME ZONE NOT NULL, "drips_issued" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_3e52dd290f54e645497b2d1a5fa" UNIQUE ("receipt_hash"), CONSTRAINT "PK_20e8dddb0f54ba002ba97f085ef" PRIMARY KEY ("entitlement_id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "entitlement"`);
    }

}
