import { z } from "zod";
import {
  WAGER_TRANSACTIONS_DLQ_NAME,
  WAGER_TRANSACTIONS_QUEUE_NAME,
} from "../messaging/queue-names";

// z.string().url() delega ao parser WHATWG URL, que aceita "localhost:4566" como uma URL
// valida de esquema "localhost:" - sem isto, um LOCALSTACK_ENDPOINT sem "http://" passaria
// a validacao e so quebraria nas camadas que de fato tentam conectar (T005).
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const envSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  LOCALSTACK_ENDPOINT: z.string().refine(isAbsoluteHttpUrl, {
    message: "must be an absolute http(s) URL",
  }),
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LEDGER_CURSOR_SECRET: z.string().min(1),
  OUTBOX_PUBLISHER_POLL_INTERVAL_MS: z.coerce.number().int().min(1).default(2000),
  OUTBOX_PUBLISHER_BATCH_SIZE: z.coerce.number().int().min(1).default(20),
  // Maximo do proprio SQS e 20 (ReceiveMessageCommand.WaitTimeSeconds) - long polling de
  // verdade, mas baixo o bastante para um SIGTERM em teste manual nao ficar preso por ate 20s.
  SQS_CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  // So existe para permitir que um teste de integracao aponte WagerTransactionSqsConsumer para
  // uma fila FIFO descartavel propria, isolada de qualquer instancia real da app rodando ao lado
  // (que sempre consome "wager-transactions.fifo" por padrao) - nunca usado em producao.
  WAGER_TRANSACTIONS_QUEUE_NAME: z.string().min(1).default(WAGER_TRANSACTIONS_QUEUE_NAME),
  // Intervalo de poll do DlqMonitorScheduler (GetQueueAttributesCommand - nunca consome a DLQ).
  DLQ_MONITOR_POLL_INTERVAL_MS: z.coerce.number().int().min(1).default(5000),
  // Mesmo principio de WAGER_TRANSACTIONS_QUEUE_NAME acima - so para isolar um teste de
  // integracao numa DLQ descartavel propria, nunca usado em producao.
  WAGER_TRANSACTIONS_DLQ_NAME: z.string().min(1).default(WAGER_TRANSACTIONS_DLQ_NAME),
});

export type EnvSchema = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuração de ambiente inválida - ${issues}`);
  }

  return result.data;
}
