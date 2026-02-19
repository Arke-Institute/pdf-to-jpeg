# PDF to JPEG Klados

Converts PDF pages to JPEG images using Ghostscript.

## Architecture

This klados uses a **Tier 2** architecture with two components:

```
pdf-to-jpeg/
├── worker/    # Cloudflare Worker + Durable Object (polling orchestrator)
└── lambda/    # AWS Lambda (PDF rendering with Ghostscript)
```

**Flow:**
1. Worker receives `POST /process` request
2. DO starts Lambda job via HTTP
3. DO polls Lambda status using alarms
4. Lambda renders PDF pages to JPEG using Ghostscript
5. Lambda uploads JPEG entities and creates relationships
6. DO returns entity IDs for workflow handoff

## Quick Start

### 1. Deploy Lambda

```bash
cd lambda
npm install
npm run build
./scripts/deploy.sh
```

Note the Function URL from the output.

### 2. Configure Worker

Update `worker/wrangler.jsonc`:
```jsonc
"vars": {
  "AGENT_ID": "",           // Set after registration
  "AGENT_VERSION": "0.1.0",
  "LAMBDA_URL": "https://xxx.lambda-url.us-east-1.on.aws"
}
```

Set secrets:
```bash
cd worker
wrangler secret put ARKE_AGENT_KEY   # Agent API key (ak_...)
wrangler secret put LAMBDA_SECRET     # Lambda auth secret
```

### 3. Deploy Worker

```bash
cd worker
npm install
npm run deploy
```

### 4. Register Klados

```bash
ARKE_USER_KEY=uk_xxx npm run register      # test network
ARKE_USER_KEY=uk_xxx npm run register:prod # main network
```

## Usage

### Invoke via API

```bash
curl -X POST https://arke-v1.arke.institute/kladoi/KLADOS_ID/invoke \
  -H "Authorization: ApiKey uk_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "target_entity": "PDF_ENTITY_ID",
    "target_collection": "COLLECTION_ID",
    "input": {
      "options": {
        "quality": 90,
        "dpi": 300,
        "max_dimension": 2400
      }
    }
  }'
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `quality` | number | 85 | JPEG quality (1-100) |
| `dpi` | number | 300 | Render resolution (72-600) |
| `max_dimension` | number | 2400 | Max dimension before resize |
| `target_file_key` | string | (auto) | Specific file to process |

### Output

For each PDF page, creates:
- A `file` entity with the JPEG image
- `derived_from` relationship to source PDF
- `has_page` relationship from source to each page

Page properties:
- `page_number`: 1-indexed page number
- `source_entity_id`: Source PDF entity ID
- `width`, `height`: Image dimensions in pixels

## Monitoring

### Worker Logs

```bash
cd worker
wrangler tail  # Must run BEFORE triggering worker
```

### Lambda Logs

View in AWS CloudWatch or via:
```bash
aws logs tail /aws/lambda/arke-pdf-to-jpeg --follow
```

### Check Job Status

Lambda endpoint:
```bash
curl https://xxx.lambda-url.us-east-1.on.aws/status/JOB_ID \
  -H "X-Lambda-Secret: your-secret"
```

## Limits

| Component | Limit |
|-----------|-------|
| PDF size | 100MB |
| Lambda timeout | 15 minutes |
| Lambda memory | 3GB (configurable) |
| Worker DO storage | 10GB |

## File Structure

```
pdf-to-jpeg/
├── worker/
│   ├── src/
│   │   ├── index.ts           # HTTP routing
│   │   ├── job-do.ts          # Durable Object
│   │   ├── job.ts             # Lambda polling logic
│   │   ├── lambda-client.ts   # Lambda HTTP client
│   │   └── types.ts           # Type definitions
│   ├── wrangler.jsonc
│   ├── package.json
│   └── agent.json
├── lambda/
│   ├── src/
│   │   ├── index.ts           # Lambda handler
│   │   ├── job.ts             # PDF processing
│   │   ├── handlers/
│   │   └── lib/
│   │       ├── pdf-render.ts  # Ghostscript rendering
│   │       └── arke.ts        # Arke SDK helpers
│   ├── template.yaml          # SAM template
│   └── package.json
└── README.md
```

## Development

### Worker

```bash
cd worker
npm run dev        # Local development
npm run type-check # TypeScript validation
npm test           # Run tests
```

### Lambda

```bash
cd lambda
npm run build      # Build bundle
npm run type-check # TypeScript validation
```

## Rhiza Integration

This klados can be used in rhiza workflows:

```json
{
  "entry": "convert_pdf",
  "flow": {
    "convert_pdf": {
      "klados": { "id": "KLADOS_ID" },
      "then": { "scatter": "process_page" }
    },
    "process_page": {
      "klados": { "id": "PAGE_PROCESSOR_ID" },
      "then": { "gather": "complete" }
    },
    "complete": {
      "klados": { "id": "AGGREGATOR_ID" },
      "then": { "done": true }
    }
  }
}
```

The klados returns multiple output entity IDs (one per page), suitable for scatter operations.
