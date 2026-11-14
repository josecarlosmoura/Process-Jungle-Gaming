export const WAGER_TRANSACTIONS_QUEUE_NAME = "wager-transactions.fifo";
export const WAGER_TRANSACTIONS_DLQ_NAME = "wager-transactions-dlq.fifo";
// FIFO (nao uma fila padrao) porque ARCHITECTURE.md secao 2.2 ja fixou MessageGroupId = aggregateId
// para esta fila - SQS so aceita MessageGroupId em filas FIFO, que por sua vez exigem o sufixo
// ".fifo" no nome.
export const INTEGRATION_EVENTS_QUEUE_NAME = "integration-events.fifo";
// Valor persistido em inbox_messages.consumer_name por toda linha gravada pelo SQS consumer de
// wager-transactions.fifo (AD-009: a chave da dedupe E esse valor, nao um id sintetico) -
// renomear depois exigiria migrar as linhas ja persistidas com o nome antigo.
export const WAGER_TRANSACTIONS_CONSUMER_NAME = "wager-transaction-sqs-consumer";
