import { Migration } from "@mikro-orm/migrations";

export class Migration20261112123041_Initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create extension if not exists "pgcrypto";`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop extension if exists "pgcrypto";`);
  }
}
