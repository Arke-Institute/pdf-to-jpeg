#!/bin/bash
# Stress test for PDF-to-JPEG with large PDFs (100+ pages)
#
# Usage:
#   ARKE_USER_KEY=uk_... ./stress-test.sh [page_count]
#
# Arguments:
#   page_count - Target page count for test (default: 150)
#                Will download a PDF with approximately this many pages
#
# This will:
# 1. Download a large public domain PDF
# 2. Create a test collection with proper permissions
# 3. Invoke the klados
# 4. Monitor progress with detailed timing
# 5. Report success/failure and any limits hit

set -e

API_BASE="${ARKE_API_BASE:-https://arke-v1.arke.institute}"
NETWORK="${ARKE_NETWORK:-test}"
KLADOS_ID="${KLADOS_ID:-IIKHSC1S77H8FBW9ZMTDMFTG1F}"
TARGET_PAGES="${1:-150}"

if [ -z "$ARKE_USER_KEY" ]; then
  echo "Error: ARKE_USER_KEY not set"
  echo "Usage: ARKE_USER_KEY=uk_... ./stress-test.sh [page_count]"
  exit 1
fi

echo "=============================================="
echo "  PDF-to-JPEG STRESS TEST ($TARGET_PAGES+ pages)"
echo "=============================================="
echo ""
echo "Configuration:"
echo "  API Base: $API_BASE"
echo "  Network: $NETWORK"
echo "  Klados: $KLADOS_ID"
echo "  Target pages: $TARGET_PAGES+"
echo ""

# Select PDF based on target page count
# Using reliable PDFs - NASA reports and tech specs are usually well-formed
if [ "$TARGET_PAGES" -lt 50 ]; then
  PDF_URL="https://www.w3.org/WAI/WCAG21/Techniques/pdf/img/table-word.pdf"
  EXPECTED_PAGES=2
  PDF_NAME="W3C Sample (2 pages)"
elif [ "$TARGET_PAGES" -lt 100 ]; then
  # Use local test PDF if available, otherwise download a reliable one
  PDF_URL="https://www.africau.edu/images/default/sample.pdf"
  EXPECTED_PAGES=2
  PDF_NAME="Sample PDF (~2 pages)"
elif [ "$TARGET_PAGES" -lt 250 ]; then
  # ECMA-262 JavaScript spec - 5th edition is smaller
  PDF_URL="https://ecma-international.org/wp-content/uploads/ECMA-262_5th_edition_december_2009.pdf"
  EXPECTED_PAGES=252
  PDF_NAME="ECMA-262 5th Ed (~252 pages)"
elif [ "$TARGET_PAGES" -lt 500 ]; then
  # C11 Standard (free draft version)
  PDF_URL="https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1548.pdf"
  EXPECTED_PAGES=701
  PDF_NAME="C11 Standard Draft (~700 pages)"
else
  # ECMA-262 latest (full JavaScript spec - very large)
  PDF_URL="https://ecma-international.org/wp-content/uploads/ECMA-262_15th_edition_june_2024.pdf"
  EXPECTED_PAGES=866
  PDF_NAME="ECMA-262 15th Ed (~866 pages)"
fi

echo "Selected PDF: $PDF_NAME"
echo "Expected pages: ~$EXPECTED_PAGES"
echo ""

# Download PDF
echo "[1/5] Downloading PDF..."
DOWNLOAD_START=$(date +%s.%N)
if ! curl -sL "$PDF_URL" -o /tmp/stress-test.pdf; then
  echo "Error: Failed to download PDF"
  echo "URL: $PDF_URL"
  exit 1
fi
DOWNLOAD_END=$(date +%s.%N)
DOWNLOAD_TIME=$(echo "$DOWNLOAD_END - $DOWNLOAD_START" | bc)

PDF_SIZE=$(wc -c < /tmp/stress-test.pdf | tr -d ' ')
PDF_SIZE_MB=$(echo "scale=2; $PDF_SIZE / 1048576" | bc)
echo "  Downloaded: ${PDF_SIZE_MB} MB in ${DOWNLOAD_TIME}s"
echo ""

# Create test collection with permissions
echo "[2/5] Creating test collection with permissions..."
COLLECTION_RESPONSE=$(curl -s -X POST "$API_BASE/collections" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Stress Test '"$(date +%s)"'",
    "description": "PDF-to-JPEG stress test with '"$EXPECTED_PAGES"' pages",
    "use_roles_default": true,
    "roles": {
      "public": ["*:view", "*:invoke", "*:create", "*:update"]
    }
  }')

COLLECTION_ID=$(echo "$COLLECTION_RESPONSE" | jq -r '.id')
if [ "$COLLECTION_ID" = "null" ] || [ -z "$COLLECTION_ID" ]; then
  echo "Error: Failed to create collection"
  echo "$COLLECTION_RESPONSE" | jq .
  exit 1
fi
echo "  Collection: $COLLECTION_ID"

# Create PDF entity
echo "[3/5] Creating PDF entity and uploading content..."
PDF_ENTITY_RESPONSE=$(curl -s -X POST "$API_BASE/entities" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file",
    "collection": "'"$COLLECTION_ID"'",
    "properties": {
      "label": "Stress Test PDF",
      "filename": "stress-test.pdf"
    }
  }')

PDF_ENTITY_ID=$(echo "$PDF_ENTITY_RESPONSE" | jq -r '.id')
if [ "$PDF_ENTITY_ID" = "null" ] || [ -z "$PDF_ENTITY_ID" ]; then
  echo "Error: Failed to create PDF entity"
  echo "$PDF_ENTITY_RESPONSE" | jq .
  exit 1
fi
echo "  PDF Entity: $PDF_ENTITY_ID"

# Upload content
UPLOAD_START=$(date +%s.%N)
UPLOAD_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/entities/$PDF_ENTITY_ID/content?key=v1" \
  -H "Authorization: ApiKey $ARKE_USER_KEY" \
  -H "X-Arke-Network: $NETWORK" \
  -H "Content-Type: application/pdf" \
  --data-binary @/tmp/stress-test.pdf)
UPLOAD_STATUS=$(echo "$UPLOAD_RESPONSE" | tail -n1)
UPLOAD_END=$(date +%s.%N)
UPLOAD_TIME=$(echo "$UPLOAD_END - $UPLOAD_START" | bc)

if [ "$UPLOAD_STATUS" != "200" ] && [ "$UPLOAD_STATUS" != "201" ]; then
  echo "Error: Failed to upload PDF content (HTTP $UPLOAD_STATUS)"
  echo "$UPLOAD_RESPONSE"
  exit 1
fi
echo "  Uploaded ${PDF_SIZE_MB}MB in ${UPLOAD_TIME}s"
echo ""

# Invoke klados
echo "[4/5] Invoking PDF-to-JPEG klados..."
START_TIME=$(date +%s)
START_TIME_NS=$(date +%s.%N)

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

if [ "$STATUS" != "started" ]; then
  echo "Error: Failed to start job"
  echo "$INVOKE_RESPONSE" | jq .
  exit 1
fi

echo "  Job ID: $JOB_ID"
echo "  Job Collection: $JOB_COLLECTION"
echo ""

# Poll for completion with progress updates
echo "[5/5] Processing (this may take several minutes for large PDFs)..."
echo ""
LAST_PHASE=""
POLL_COUNT=0

while true; do
  POLL_COUNT=$((POLL_COUNT + 1))
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  # Query collection for log entity ID
  LOGS_LIST=$(curl -s "$API_BASE/collections/$JOB_COLLECTION/entities?type=klados_log" \
    -H "Authorization: ApiKey $ARKE_USER_KEY" \
    -H "X-Arke-Network: $NETWORK")

  LOG_ID=$(echo "$LOGS_LIST" | jq -r '.entities[0].id // empty')

  if [ -z "$LOG_ID" ]; then
    printf "\r  [%3ds] Waiting for log entity...                    " "$ELAPSED"
    sleep 3
    continue
  fi

  # Fetch full log entity with properties
  LOGS=$(curl -s "$API_BASE/entities/$LOG_ID" \
    -H "Authorization: ApiKey $ARKE_USER_KEY" \
    -H "X-Arke-Network: $NETWORK")

  LOG_STATUS=$(echo "$LOGS" | jq -r '.properties.status // "pending"')

  # Try to get progress from log messages
  MESSAGES=$(echo "$LOGS" | jq -r '.properties.log_data.messages // []')
  LATEST_MSG=$(echo "$MESSAGES" | jq -r '.[-1].message // ""')

  # Display progress
  printf "\r  [%3ds] Status: %-10s | %s                    " "$ELAPSED" "$LOG_STATUS" "$LATEST_MSG"

  if [ "$LOG_STATUS" = "done" ]; then
    END_TIME=$(date +%s)
    END_TIME_NS=$(date +%s.%N)
    DURATION=$((END_TIME - START_TIME))
    DURATION_PRECISE=$(echo "$END_TIME_NS - $START_TIME_NS" | bc)

    echo ""
    echo ""
    echo "=============================================="
    echo "               SUCCESS!"
    echo "=============================================="
    echo ""

    # Show timing breakdown
    echo "Timing:"
    echo "  Total processing time: ${DURATION}s"

    # Extract detailed messages
    echo ""
    echo "Log messages:"
    echo "$LOGS" | jq -r '.properties.log_data.messages[] | "  [\(.level)] \(.message)"' 2>/dev/null || echo "  (no messages)"

    # Show outputs
    OUTPUTS=$(echo "$LOGS" | jq -r '.properties.log_data.entry.outputs // []')
    OUTPUT_COUNT=$(echo "$OUTPUTS" | jq 'length')
    echo ""
    echo "Results:"
    echo "  Pages created: $OUTPUT_COUNT"
    echo "  Expected pages: ~$EXPECTED_PAGES"

    if [ "$OUTPUT_COUNT" -gt 0 ]; then
      RATE=$(echo "scale=2; $OUTPUT_COUNT / $DURATION" | bc)
      echo "  Processing rate: ${RATE} pages/second"
    fi

    # Check for any errors in messages
    ERROR_COUNT=$(echo "$MESSAGES" | jq '[.[] | select(.level == "error")] | length')
    if [ "$ERROR_COUNT" -gt 0 ]; then
      echo ""
      echo "Warnings/Errors found in logs:"
      echo "$MESSAGES" | jq -r '.[] | select(.level == "error") | "  \(.message)"'
    fi

    break

  elif [ "$LOG_STATUS" = "error" ]; then
    echo ""
    echo ""
    echo "=============================================="
    echo "               FAILED!"
    echo "=============================================="
    echo ""

    # Show error details
    ERROR_INFO=$(echo "$LOGS" | jq -r '.properties.log_data.entry.error // {}')
    ERROR_CODE=$(echo "$ERROR_INFO" | jq -r '.code // "UNKNOWN"')
    ERROR_MSG=$(echo "$ERROR_INFO" | jq -r '.message // "No error message"')

    echo "Error Code: $ERROR_CODE"
    echo "Error Message: $ERROR_MSG"
    echo ""
    echo "Full error details:"
    echo "$ERROR_INFO" | jq .

    echo ""
    echo "Log messages leading up to error:"
    echo "$LOGS" | jq -r '.properties.log_data.messages[] | "  [\(.level)] \(.message)"' 2>/dev/null

    # Don't cleanup on error - leave artifacts for debugging
    echo ""
    echo "Artifacts left for debugging:"
    echo "  Collection: $COLLECTION_ID"
    echo "  PDF Entity: $PDF_ENTITY_ID"
    echo "  Job Collection: $JOB_COLLECTION"

    exit 1
  fi

  # Timeout after 15 minutes (Lambda max)
  if [ "$ELAPSED" -gt 900 ]; then
    echo ""
    echo ""
    echo "=============================================="
    echo "               TIMEOUT!"
    echo "=============================================="
    echo "Job did not complete within 15 minutes"
    echo ""
    echo "Last status: $LOG_STATUS"
    echo "Last message: $LATEST_MSG"

    # Leave artifacts for debugging
    echo ""
    echo "Artifacts left for debugging:"
    echo "  Collection: $COLLECTION_ID"
    echo "  PDF Entity: $PDF_ENTITY_ID"
    echo "  Job Collection: $JOB_COLLECTION"

    exit 1
  fi

  sleep 5
done

# Verify outputs by checking a sample
echo ""
echo "Verifying outputs..."
FIRST_OUTPUT=$(echo "$OUTPUTS" | jq -r '.[0]')
if [ "$FIRST_OUTPUT" != "null" ] && [ -n "$FIRST_OUTPUT" ]; then
  FIRST_ENTITY=$(curl -s "$API_BASE/entities/$FIRST_OUTPUT" \
    -H "Authorization: ApiKey $ARKE_USER_KEY" \
    -H "X-Arke-Network: $NETWORK")

  ENTITY_TYPE=$(echo "$FIRST_ENTITY" | jq -r '.type')
  PAGE_NUM=$(echo "$FIRST_ENTITY" | jq -r '.properties.page_number')
  WIDTH=$(echo "$FIRST_ENTITY" | jq -r '.properties.width')
  HEIGHT=$(echo "$FIRST_ENTITY" | jq -r '.properties.height')

  echo "  Sample output entity:"
  echo "    ID: $FIRST_OUTPUT"
  echo "    Type: $ENTITY_TYPE"
  echo "    Page: $PAGE_NUM"
  echo "    Dimensions: ${WIDTH}x${HEIGHT}"
fi

# Cleanup option
echo ""
read -p "Cleanup test artifacts? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Cleaning up..."
  curl -s -X DELETE "$API_BASE/entities/$COLLECTION_ID" \
    -H "Authorization: ApiKey $ARKE_USER_KEY" \
    -H "X-Arke-Network: $NETWORK" > /dev/null
  echo "Cleanup complete"
else
  echo "Artifacts preserved:"
  echo "  Collection: $COLLECTION_ID"
  echo "  PDF Entity: $PDF_ENTITY_ID"
  echo "  Job Collection: $JOB_COLLECTION"
fi

echo ""
echo "Stress test complete!"
