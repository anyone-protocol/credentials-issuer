import { MigrationInterface, QueryRunner } from "typeorm";

export class IdempotencyRecord1788490167838 implements MigrationInterface {
    name = 'IdempotencyRecord1788490167838'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "idempotency_record" ("payment_ref" text NOT NULL, "idempotency_key" text NOT NULL, "request_fingerprint" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_796132d58c0ffc34e5b0585cbf5" PRIMARY KEY ("payment_ref", "idempotency_key"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "idempotency_record"`);
    }

}
