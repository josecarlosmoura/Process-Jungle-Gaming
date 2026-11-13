import { Migration } from "@mikro-orm/migrations";

export class Migration20261113180000_CreateOutboxMessages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" text not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" int not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_attempts_non_negative_check" check ("attempts" >= 0)
      );
    `);

    this.addSql(`
      create index "outbox_messages_published_next_attempt_idx"
      on "outbox_messages" ("published_at", "next_attempt_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
  }
}
