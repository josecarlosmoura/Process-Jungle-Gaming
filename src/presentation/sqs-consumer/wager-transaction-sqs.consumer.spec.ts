import { describe, expect, test } from "bun:test";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { ConsumeWagerTransactionMessageUseCase } from "../../application/use-cases/consume-wager-transaction-message.use-case";
import { WagerTransactionSqsConsumer } from "./wager-transaction-sqs.consumer";

function fakeOrm(): MikroORM {
  // RequestContext.create so chama em.fork({useContext:true}) e guarda o resultado por em.name -
  // nunca faz instanceof MikroORM/EntityManager, entao este shape minimo basta (mesmo padrao de
  // outbox-publisher.scheduler.spec.ts).
  return { em: { name: "default", fork: () => ({}) } } as unknown as MikroORM;
}

function validEnvelopeBody(dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: "msg-1",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      idempotencyKey: "provider-a:tx-1",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...dataOverrides,
    },
  });
}

function fakeSqsClient(messageBatches: Message[][]): {
  client: SQSClient;
  receiveCallCount: () => number;
  deletedHandles: () => string[];
} {
  let receiveCalls = 0;
  const deletedHandles: string[] = [];
  let index = 0;
  const send = async (command: { constructor: { name: string }; input?: { ReceiptHandle?: string } }) => {
    switch (command.constructor.name) {
      case "GetQueueUrlCommand":
        return { QueueUrl: "http://localhost:4566/000000000000/wager-transactions.fifo" };
      case "ReceiveMessageCommand": {
        receiveCalls += 1;
        const batch = messageBatches[index] ?? [];
        index += 1;
        if (batch.length === 0) {
          // SQS real so devolve vazio depois de ate WaitTimeSeconds bloqueado no servidor - sem
          // simular isso aqui, o loop giraria em busy-loop reenviando ReceiveMessageCommand sem
          // nenhuma pausa real, nunca cedendo o event loop para o wait()/onModuleDestroy do teste.
          await wait(10);
        }
        return { Messages: batch };
      }
      case "DeleteMessageCommand":
        if (command.input?.ReceiptHandle) {
          deletedHandles.push(command.input.ReceiptHandle);
        }
        return {};
      default:
        throw new Error(`unexpected command ${command.constructor.name}`);
    }
  };
  return {
    client: { send } as unknown as SQSClient,
    receiveCallCount: () => receiveCalls,
    deletedHandles: () => deletedHandles,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("WagerTransactionSqsConsumer", () => {
  test("a message that fails translation is deleted without ever reaching the use case", async () => {
    const { client, deletedHandles } = fakeSqsClient([
      [{ MessageId: "sqs-1", ReceiptHandle: "handle-1", Body: "not json" }],
    ]);
    let useCaseCalls = 0;
    const useCase = {
      execute: async () => {
        useCaseCalls += 1;
        return { outcome: "PROCESSED" };
      },
    } as unknown as ConsumeWagerTransactionMessageUseCase;
    const consumer = new WagerTransactionSqsConsumer(fakeOrm(), client, useCase, 0);

    try {
      consumer.onApplicationBootstrap();
      await wait(50);

      expect(useCaseCalls).toBe(0);
      expect(deletedHandles()).toEqual(["handle-1"]);
    } finally {
      await consumer.onModuleDestroy();
    }
  });

  test("a message with a malformed money amount is deleted without ever reaching the use case", async () => {
    const { client, deletedHandles } = fakeSqsClient([
      [{ MessageId: "sqs-1", ReceiptHandle: "handle-1", Body: validEnvelopeBody({ money: { amount: "", currency: "BRL" } }) }],
    ]);
    let useCaseCalls = 0;
    const useCase = {
      execute: async () => {
        useCaseCalls += 1;
        return { outcome: "PROCESSED" };
      },
    } as unknown as ConsumeWagerTransactionMessageUseCase;
    const consumer = new WagerTransactionSqsConsumer(fakeOrm(), client, useCase, 0);

    try {
      consumer.onApplicationBootstrap();
      await wait(50);

      expect(useCaseCalls).toBe(0);
      expect(deletedHandles()).toEqual(["handle-1"]);
    } finally {
      await consumer.onModuleDestroy();
    }
  });

  test("onModuleDestroy waits for the in-flight message to finish and never receives another message after stop", async () => {
    const { client, receiveCallCount, deletedHandles } = fakeSqsClient([
      [{ MessageId: "sqs-1", ReceiptHandle: "handle-1", Body: validEnvelopeBody() }],
    ]);
    let resolveExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      resolveExecute = resolve;
    });
    let useCaseCalls = 0;
    const useCase = {
      execute: async () => {
        useCaseCalls += 1;
        await executeGate;
        return { outcome: "PROCESSED" };
      },
    } as unknown as ConsumeWagerTransactionMessageUseCase;
    const consumer = new WagerTransactionSqsConsumer(fakeOrm(), client, useCase, 0);

    consumer.onApplicationBootstrap();
    await wait(30);
    expect(useCaseCalls).toBe(1);

    let destroyResolved = false;
    const destroyPromise = consumer.onModuleDestroy().then(() => {
      destroyResolved = true;
    });
    await wait(30);
    expect(destroyResolved).toBe(false);
    expect(consumer.isStopped()).toBe(true);

    resolveExecute();
    await destroyPromise;

    expect(destroyResolved).toBe(true);
    expect(deletedHandles()).toEqual(["handle-1"]);
    expect(receiveCallCount()).toBe(1);
  });
});
