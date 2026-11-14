import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: "consumer_name", type: "text" })
  consumerName!: string;

  @PrimaryKey({ fieldName: "message_id", type: "text" })
  messageId!: string;

  @Property({ fieldName: "payload_hash", type: "text" })
  payloadHash!: string;

  @Property({ fieldName: "received_at" })
  receivedAt!: Date;

  @Property({ fieldName: "processed_at", nullable: true })
  processedAt?: Date;
}
