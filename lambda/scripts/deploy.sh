#!/bin/bash
# Deploy Lambda function using SAM

set -e

# Configuration
STACK_NAME="${STACK_NAME:-arke-file-processor}"
PROCESSOR_NAME="${PROCESSOR_NAME:-file-processor}"
REGION="${AWS_REGION:-us-east-1}"

echo "Building Lambda..."
npm run build

echo "Deploying ${STACK_NAME} to ${REGION}..."

sam deploy \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ProcessorName="${PROCESSOR_NAME}" \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset

echo ""
echo "Deployment complete!"
echo ""

# Get outputs
FUNCTION_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query 'Stacks[0].Outputs[?OutputKey==`FunctionUrl`].OutputValue' \
  --output text)

TABLE_NAME=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query 'Stacks[0].Outputs[?OutputKey==`TableName`].OutputValue' \
  --output text)

echo "Function URL: ${FUNCTION_URL}"
echo "DynamoDB Table: ${TABLE_NAME}"
