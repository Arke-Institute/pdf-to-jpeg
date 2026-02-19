#!/bin/bash
# Create DynamoDB table for job state (standalone, without SAM)

set -e

TABLE_NAME="${1:-arke-processor-jobs}"
REGION="${AWS_REGION:-us-east-1}"

echo "Creating DynamoDB table: ${TABLE_NAME}"

aws dynamodb create-table \
  --table-name "${TABLE_NAME}" \
  --attribute-definitions \
    AttributeName=job_id,AttributeType=S \
  --key-schema \
    AttributeName=job_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "${REGION}" \
  --tags Key=Service,Value=arke-processor

echo "Enabling TTL..."

aws dynamodb update-time-to-live \
  --table-name "${TABLE_NAME}" \
  --time-to-live-specification Enabled=true,AttributeName=ttl \
  --region "${REGION}"

echo ""
echo "Table created: ${TABLE_NAME}"
echo "Set DYNAMODB_TABLE=${TABLE_NAME} in your Lambda environment"
