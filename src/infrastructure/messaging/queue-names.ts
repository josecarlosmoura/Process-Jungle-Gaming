export const WAGER_TRANSACTIONS_QUEUE_NAME = "wager-transactions.fifo";
export const WAGER_TRANSACTIONS_DLQ_NAME = "wager-transactions-dlq.fifo";
// FIFO (nao uma fila padrao) porque ARCHITECTURE.md secao 2.2 ja fixou MessageGroupId = aggregateId
// para esta fila - SQS so aceita MessageGroupId em filas FIFO, que por sua vez exigem o sufixo
// ".fifo" no nome.
export const INTEGRATION_EVENTS_QUEUE_NAME = "integration-events.fifo";
