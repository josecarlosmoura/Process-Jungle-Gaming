#!/usr/bin/env bash
set -euo pipefail

ENDPOINT_URL="${SQS_ENDPOINT_URL:-http://localhost:4566}"
REGION="${AWS_REGION:-us-east-1}"
MAIN_QUEUE_NAME="wager-transactions.fifo"
DLQ_NAME="wager-transactions-dlq.fifo"
INTEGRATION_EVENTS_QUEUE_NAME="integration-events.fifo"
VISIBILITY_TIMEOUT_SECONDS=30
# Valor provisorio: a politica final de retry/backoff da DLQ e escolhida e justificada numa
# tarefa futura dedicada a isso. Aqui so precisa existir a associacao de redrive policy.
MAX_RECEIVE_COUNT=5

aws_sqs() {
  aws --endpoint-url="$ENDPOINT_URL" --region="$REGION" sqs "$@"
}

# create-queue com os mesmos atributos de uma execucao anterior e idempotente por natureza
# da API SQS. Mas se os atributos informados mudarem entre execucoes (ex.: quando uma tarefa
# futura fixar o valor final de MAX_RECEIVE_COUNT), create-queue falha com QueueAlreadyExists
# em vez de atualizar - sem o fallback para set-queue-attributes abaixo, rodar este script de
# novo depois de uma mudanca quebraria em vez de convergir.
create_or_update_queue() {
  local queue_name="$1"
  local attributes_json="$2"
  local output queue_url

  if output=$(aws_sqs create-queue --queue-name "$queue_name" --attributes "$attributes_json" --query 'QueueUrl' --output text 2>&1); then
    echo "$output"
    return 0
  fi

  if ! echo "$output" | grep -q "QueueAlreadyExists"; then
    echo "$output" >&2
    return 1
  fi

  queue_url=$(aws_sqs get-queue-url --queue-name "$queue_name" --query 'QueueUrl' --output text)
  aws_sqs set-queue-attributes --queue-url "$queue_url" --attributes "$attributes_json" >/dev/null
  echo "$queue_url"
}

dlq_attributes="{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"${VISIBILITY_TIMEOUT_SECONDS}\"}"
dlq_url=$(create_or_update_queue "$DLQ_NAME" "$dlq_attributes")

dlq_arn=$(aws_sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

# RedrivePolicy e, na propria API do SQS, uma string contendo JSON - nao um objeto aninhado -
# por isso o escape manual das aspas internas antes de embutir no JSON de --attributes.
redrive_policy="{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":${MAX_RECEIVE_COUNT}}"
redrive_policy_escaped=${redrive_policy//\"/\\\"}
main_attributes="{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"${VISIBILITY_TIMEOUT_SECONDS}\",\"RedrivePolicy\":\"${redrive_policy_escaped}\"}"
main_url=$(create_or_update_queue "$MAIN_QUEUE_NAME" "$main_attributes")

# Fila de saida do Outbox Publisher Worker (T209) - sem DLQ propria na especificacao; cada
# mensagem publicada ja traz MessageDeduplicationId explicito, nunca depende de
# ContentBasedDeduplication.
integration_events_attributes="{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"${VISIBILITY_TIMEOUT_SECONDS}\"}"
integration_events_url=$(create_or_update_queue "$INTEGRATION_EVENTS_QUEUE_NAME" "$integration_events_attributes")

echo "DLQ:               $dlq_url"
echo "Main queue:         $main_url"
echo "Integration events: $integration_events_url"
