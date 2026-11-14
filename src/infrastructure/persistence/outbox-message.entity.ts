import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "outbox_messages" })
export class OutboxMessageEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "aggregate_id", type: "uuid" })
  aggregateId!: string;

  @Property({ fieldName: "event_type", type: "text" })
  eventType!: string;

  @Property({ type: "json", columnType: "jsonb" })
  payload!: Record<string, unknown>;

  @Property({ fieldName: "occurred_at" })
  occurredAt!: Date;

  @Property({ type: "number" })
  attempts!: number;

  @Property({ fieldName: "next_attempt_at", nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: "published_at", nullable: true })
  publishedAt?: Date;
}
