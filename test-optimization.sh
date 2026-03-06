#!/bin/bash
# Quick test for PDF-to-JPEG optimization
#
# Usage:
#   ARKE_USER_KEY=uk_... ./test-optimization.sh
#
# This will:
# 1. Create a test collection
# 2. Create a test PDF entity with a sample PDF
# 3. Invoke the klados
# 4. Wait for completion and show timing

set -e

API_BASE="${ARKE_API_BASE:-https://arke-v1.arke.institute}"
NETWORK="${ARKE_NETWORK:-test}"
KLADOS_ID="${KLADOS_ID:-IIKHSC1S77H8FBW9ZMTDMFTG1F}"

if [ -z "$ARKE_USER_KEY" ]; then
  echo "Error: ARKE_USER_KEY not set"
  echo "Usage: ARKE_USER_KEY=uk_... ./test-optimization.sh"
  exit 1
fi

echo "=== PDF-to-JPEG Optimization Test ==="
echo "API Base: $API_BASE"
echo "Network: $NETWORK"
echo "Klados: $KLADOS_ID"
echo ""

# Create test collection
echo "Creating test collection..."
COLLECTION_RESPONSE=$(curl -s -X POST "$API_BASE/entities" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "collection",
    "properties": {
      "label": "PDF-to-JPEG Test '"$(date +%s)"'"
    }
  }')

COLLECTION_ID=$(echo "$COLLECTION_RESPONSE" | jq -r '.id')
echo "Created collection: $COLLECTION_ID"

# Create test entity with PDF (use a sample PDF URL)
echo "Creating test PDF entity..."
PDF_ENTITY_RESPONSE=$(curl -s -X POST "$API_BASE/entities" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file",
    "collection": "'"$COLLECTION_ID"'",
    "properties": {
      "label": "Test PDF",
      "filename": "test.pdf"
    }
  }')

PDF_ENTITY_ID=$(echo "$PDF_ENTITY_RESPONSE" | jq -r '.id')
echo "Created PDF entity: $PDF_ENTITY_ID"

# Upload a simple PDF
echo "Uploading PDF content..."
# Generate a simple multi-page PDF using curl to download a sample
SAMPLE_PDF_URL="https://www.w3.org/WAI/WCAG21/Techniques/pdf/img/table-word.pdf"
curl -s "$SAMPLE_PDF_URL" -o /tmp/test.pdf
PDF_SIZE=$(wc -c < /tmp/test.pdf)
echo "Downloaded sample PDF: ${PDF_SIZE} bytes"

curl -s -X POST "$API_BASE/entities/$PDF_ENTITY_ID/content?key=v1" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" \
  -H "Content-Type: application/pdf" \
  --data-binary @/tmp/test.pdf > /dev/null

echo "PDF content uploaded"

# Invoke klados
echo ""
echo "Invoking PDF-to-JPEG klados..."
START_TIME=$(date +%s)

INVOKE_RESPONSE=$(curl -s -X POST "$API_BASE/kladoi/$KLADOS_ID/invoke" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" \
  -H "Content-Type: application/json" \
  -d '{
    "target_entity": "'"$PDF_ENTITY_ID"'",
    "target_collection": "'"$COLLECTION_ID"'",
    "confirm": true
  }')

JOB_ID=$(echo "$INVOKE_RESPONSE" | jq -r '.job_id')
JOB_COLLECTION=$(echo "$INVOKE_RESPONSE" | jq -r '.job_collection')
STATUS=$(echo "$INVOKE_RESPONSE" | jq -r '.status')

echo "Job started: $JOB_ID"
echo "Job collection: $JOB_COLLECTION"
echo "Initial status: $STATUS"
echo ""

# Poll for completion
echo "Waiting for completion..."
while true; do
  LOGS=$(curl -s "$API_BASE/collections/$JOB_COLLECTION/entities?type=klados_log" \
    -H "Authorization: ApiKey $ARKE_USER_KEY" \
    -H "X-Arke-Network: $NETWORK")

  LOG_STATUS=$(echo "$LOGS" | jq -r '.[0].properties.status // empty')

  if [ "$LOG_STATUS" = "done" ]; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    echo ""
    echo "=== COMPLETED ==="
    echo "Total time: ${DURATION} seconds"

    # Show log messages
    echo ""
    echo "Log messages:"
    echo "$LOGS" | jq -r '.[0].properties.log_data.messages[] | "  [\(.level)] \(.message)"'

    # Show outputs
    OUTPUTS=$(echo "$LOGS" | jq -r '.[0].properties.log_data.entry.outputs // []')
    OUTPUT_COUNT=$(echo "$OUTPUTS" | jq 'length')
    echo ""
    echo "Output entity IDs ($OUTPUT_COUNT pages created):"
    echo "$OUTPUTS" | jq -r '.[]' | head -5
    if [ "$OUTPUT_COUNT" -gt 5 ]; then
      echo "  ... and $((OUTPUT_COUNT - 5)) more"
    fi
    break
  elif [ "$LOG_STATUS" = "error" ]; then
    echo ""
    echo "=== ERROR ==="
    echo "$LOGS" | jq -r '.[0].properties.log_data.entry.error'
    exit 1
  else
    echo -n "."
    sleep 3
  fi
done

# Cleanup
echo ""
echo "Cleaning up test collection..."
curl -s -X DELETE "$API_BASE/entities/$COLLECTION_ID" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" > /dev/null

echo "Done!"
