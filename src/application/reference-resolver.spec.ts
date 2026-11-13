import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Money } from "../domain/money";
import {
  WagerTransaction,
  type ReversalKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { WagerTransactionRepository } from "./ports/wager-transaction.repository";
import { ReferenceResolver, type ReferenceSubject } from "./reference-resolver";

class FakeWagerTransactionRepository implements WagerTransactionRepository {
  private readonly byProviderAndExternalId = new Map<string, WagerTransaction>();
  private readonly reversalsByReferenceAndKind = new Map<string, WagerTransaction>();

  seedReference(
    transaction: WagerTransaction,
    providerId: string,
    externalTransactionId: string,
  ): void {
    this.byProviderAndExternalId.set(`${providerId}:${externalTransactionId}`, transaction);
  }

  seedReversal(
    referenceTransactionId: string,
    kind: ReversalKind,
    reversal: WagerTransaction,
  ): void {
    this.reversalsByReferenceAndKind.set(`${referenceTransactionId}:${kind}`, reversal);
  }

  async findByIdempotencyKey(): Promise<WagerTransaction | null> {
    throw new Error("not used by ReferenceResolver");
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null> {
    return this.byProviderAndExternalId.get(`${providerId}:${externalId}`) ?? null;
  }

  async findReversalOf(
    referenceTransactionId: string,
    reversalKind: ReversalKind,
  ): Promise<WagerTransaction | null> {
    return (
      this.reversalsByReferenceAndKind.get(`${referenceTransactionId}:${reversalKind}`) ?? null
    );
  }

  async save(): Promise<void> {
    throw new Error("not used by ReferenceResolver");
  }
}

function aReference(
  overrides: Partial<ReferenceSubject> & {
    status?: WagerTransactionStatus;
    kind?: "BET" | "WIN";
  } = {},
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: randomUUID(),
    providerId: overrides.providerId ?? "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: overrides.walletId ?? "wallet-a",
    playerId: overrides.playerId ?? "player-a",
    roundId: overrides.roundId ?? "round-a",
    gameId: "game-a",
    kind: overrides.kind ?? "BET",
    money: overrides.money ?? Money.from({ amount: "10.00", currency: "BRL" }),
    createdAt: new Date(),
    status: overrides.status ?? "PROCESSED",
  });
}

function aSubject(overrides: Partial<ReferenceSubject> = {}): ReferenceSubject {
  return {
    providerId: overrides.providerId ?? "provider-a",
    playerId: overrides.playerId ?? "player-a",
    walletId: overrides.walletId ?? "wallet-a",
    roundId: overrides.roundId ?? "round-a",
    money: overrides.money ?? Money.from({ amount: "10.00", currency: "BRL" }),
  };
}

describe("ReferenceResolver", () => {
  describe("resolve", () => {
    test("returns RESOLVED when the reference matches provider, player, wallet, currency and round", async () => {
      const repository = new FakeWagerTransactionRepository();
      const reference = aReference();
      repository.seedReference(reference, "provider-a", "external-a");
      const resolver = new ReferenceResolver(repository);

      const result = await resolver.resolve({
        ...aSubject(),
        referenceExternalTransactionId: "external-a",
      });

      expect(result).toEqual({ outcome: "RESOLVED", reference });
    });

    test("returns NOT_FOUND when no transaction matches the composite key", async () => {
      const repository = new FakeWagerTransactionRepository();
      const resolver = new ReferenceResolver(repository);

      const result = await resolver.resolve({
        ...aSubject(),
        referenceExternalTransactionId: "missing",
      });

      expect(result).toEqual({ outcome: "NOT_FOUND" });
    });

    test("returns NOT_FOUND for a still in-flight status, table-driven over PENDING and PENDING_REFERENCE", async () => {
      for (const status of ["PENDING", "PENDING_REFERENCE"] as const) {
        const repository = new FakeWagerTransactionRepository();
        repository.seedReference(aReference({ status }), "provider-a", "external-a");
        const resolver = new ReferenceResolver(repository);

        const result = await resolver.resolve({
          ...aSubject(),
          referenceExternalTransactionId: "external-a",
        });

        expect(result).toEqual({ outcome: "NOT_FOUND" });
      }
    });

    test("returns UNRESOLVABLE for a terminal non-PROCESSED status, table-driven over REJECTED and FAILED", async () => {
      for (const status of ["REJECTED", "FAILED"] as const) {
        const repository = new FakeWagerTransactionRepository();
        repository.seedReference(aReference({ status }), "provider-a", "external-a");
        const resolver = new ReferenceResolver(repository);

        const result = await resolver.resolve({
          ...aSubject(),
          referenceExternalTransactionId: "external-a",
        });

        expect(result).toEqual({ outcome: "UNRESOLVABLE" });
      }
    });

    test("returns MISMATCH when any of the five subject fields diverges, table-driven over providerId, playerId, walletId, currency and roundId, plus the matching strong case", async () => {
      const divergentSubjectsPerField: Array<Partial<ReferenceSubject>> = [
        { providerId: "provider-b" },
        { playerId: "player-b" },
        { walletId: "wallet-b" },
        { money: Money.from({ amount: "10.00", currency: "USD" }) },
        { roundId: "round-b" },
      ];

      for (const divergentSubject of divergentSubjectsPerField) {
        const repository = new FakeWagerTransactionRepository();
        const subject = aSubject(divergentSubject);
        // Semeada sob a chave que o subject efetivamente consulta (o providerId do proprio
        // subject, que diverge do padrao so no caso do primeiro item da tabela) - a referencia
        // devolvida mantem os valores padrao de aReference() em todos os campos, para que so o
        // campo sob teste divirja. No repositorio real isso nunca ocorre para providerId (a busca
        // ja filtra por ele), mas exercita a comparacao defensiva de matchesSubject mesmo assim.
        repository.seedReference(aReference(), subject.providerId, "external-a");
        const resolver = new ReferenceResolver(repository);

        const result = await resolver.resolve({
          ...subject,
          referenceExternalTransactionId: "external-a",
        });

        expect(result).toEqual({ outcome: "MISMATCH" });
      }

      // o caso forte: batendo nos cinco campos, nunca MISMATCH
      const repository = new FakeWagerTransactionRepository();
      const reference = aReference();
      repository.seedReference(reference, "provider-a", "external-a");
      const resolver = new ReferenceResolver(repository);

      const result = await resolver.resolve({
        ...aSubject(),
        referenceExternalTransactionId: "external-a",
      });

      expect(result).toEqual({ outcome: "RESOLVED", reference });
    });

    test("returns ALREADY_REVERSED when a reversal of the same kind already references the resolved transaction", async () => {
      const repository = new FakeWagerTransactionRepository();
      const reference = aReference();
      repository.seedReference(reference, "provider-a", "external-a");
      repository.seedReversal(reference.id, "REFUND", aReference());
      const resolver = new ReferenceResolver(repository);

      const result = await resolver.resolve({
        ...aSubject(),
        referenceExternalTransactionId: "external-a",
        reversalKind: "REFUND",
      });

      expect(result).toEqual({ outcome: "ALREADY_REVERSED" });
    });

    test("still returns RESOLVED when only a reversal of the other kind exists, table-driven over REFUND and ROLLBACK", async () => {
      for (const reversalKind of ["REFUND", "ROLLBACK"] as const) {
        const otherKind: ReversalKind = reversalKind === "REFUND" ? "ROLLBACK" : "REFUND";
        const repository = new FakeWagerTransactionRepository();
        const reference = aReference();
        repository.seedReference(reference, "provider-a", "external-a");
        repository.seedReversal(reference.id, otherKind, aReference());
        const resolver = new ReferenceResolver(repository);

        const result = await resolver.resolve({
          ...aSubject(),
          referenceExternalTransactionId: "external-a",
          reversalKind,
        });

        expect(result).toEqual({ outcome: "RESOLVED", reference });
      }
    });

    test("skips the already-reversed check entirely when no reversalKind is given", async () => {
      const repository = new FakeWagerTransactionRepository();
      const reference = aReference();
      repository.seedReference(reference, "provider-a", "external-a");
      repository.seedReversal(reference.id, "REFUND", aReference());
      repository.seedReversal(reference.id, "ROLLBACK", aReference());
      const resolver = new ReferenceResolver(repository);

      const result = await resolver.resolve({
        ...aSubject(),
        referenceExternalTransactionId: "external-a",
      });

      expect(result).toEqual({ outcome: "RESOLVED", reference });
    });
  });
});
