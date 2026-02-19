# Lambda PDF-to-JPEG Processor

AWS Lambda for converting PDF pages to JPEG images using Ghostscript.

## Features

- **PDF rendering**: Converts PDF pages to high-quality JPEG images using Ghostscript
- **Configurable output**: Quality, DPI, and max dimension settings
- **Async job pattern**: POST /start returns immediately, poll GET /status/:id for progress
- **Arke integration**: Creates file entities with relationships to source PDF
- **Progress tracking**: Real-time progress updates for rendering and uploading phases

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Build**:
   ```bash
   npm run build
   ```

3. **Deploy**:
   ```bash
   ./scripts/deploy.sh
   ```

## API

### POST /start

Start PDF to JPEG conversion.

**Request**:
```json
{
  "entity_id": "ENTITY_ID",
  "api_base": "https://arke-v1.arke.institute",
  "api_key": "ak_xxx",
  "network": "test",
  "collection": "COLLECTION_ID",
  "target_file_key": "document.pdf",
  "options": {
    "quality": 85,
    "dpi": 300,
    "max_dimension": 2400
  }
}
```

**Options**:
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `quality` | number | 85 | JPEG quality (1-100) |
| `dpi` | number | 300 | Render resolution (72-600) |
| `max_dimension` | number | 2400 | Max width/height before resize (100-10000) |

**Response**:
```json
{
  "success": true,
  "job_id": "job_ABC123",
  "status": "pending"
}
```

### GET /status/:job_id

Poll job status and progress.

**Response (processing)**:
```json
{
  "success": true,
  "job_id": "job_ABC123",
  "status": "processing",
  "phase": "rendering",
  "progress": {
    "phase": "rendering",
    "total_pages": 10,
    "pages_rendered": 5,
    "pages_uploaded": 0
  }
}
```

**Response (done)**:
```json
{
  "success": true,
  "job_id": "job_ABC123",
  "status": "done",
  "phase": "complete",
  "result": {
    "source_id": "ENTITY_ID",
    "total_pages": 10,
    "pages": [
      {
        "page_number": 1,
        "entity_id": "FILE_ID_1",
        "width": 2400,
        "height": 3200,
        "size_bytes": 245678
      }
    ],
    "entity_ids": ["FILE_ID_1", "FILE_ID_2", "..."]
  }
}
```

**Phases**:
- `downloading` - Downloading PDF from source entity
- `rendering` - Rendering PDF pages to JPEG with Ghostscript
- `uploading` - Uploading JPEG files to Arke
- `linking` - Creating relationships between source and pages
- `complete` - Processing finished

## Output

For each PDF page, the processor creates:
- A **file entity** with the JPEG image
- A `derived_from` relationship pointing to the source PDF
- The source PDF gets `has_page` relationships to all pages

Page entities include properties:
- `page_number`: 1-indexed page number
- `source_entity_id`: ID of the source PDF entity
- `width`: Image width in pixels
- `height`: Image height in pixels

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMODB_TABLE` | Yes | DynamoDB table name for job state |
| `LAMBDA_SECRET` | Yes | Secret for authenticating requests |

### SAM Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ProcessorName` | pdf-to-jpeg | Name for resources |
| `MemorySize` | 3008 | Lambda memory in MB (needs more for PDF processing) |
| `Timeout` | 900 | Lambda timeout in seconds (15 min max) |

## Architecture

Uses the [Ghostscript Lambda layer](https://github.com/shelfio/ghostscript-lambda-layer) for PDF rendering:
- Layer ARN: `arn:aws:lambda:us-east-1:764866452798:layer:ghostscript:17`
- Architecture: x86_64 (required for layer compatibility)

Processing flow:
1. Download PDF from Arke entity
2. Save to /tmp and get page count
3. Render each page to JPEG using Ghostscript
4. Resize with Sharp if exceeds max_dimension
5. Upload each page as file entity
6. Create relationships

## Limits

- **Max PDF size**: 100MB
- **Max pages**: Limited by Lambda timeout (900s)
- **Memory**: 3GB default (increase for very large pages)

## File Structure

```
lambda-pdf-to-jpeg/
├── src/
│   ├── index.ts              # HTTP routing
│   ├── job.ts                # PDF processing logic
│   ├── handlers/
│   │   ├── start.ts          # Job creation
│   │   ├── status.ts         # Status polling
│   │   └── process.ts        # Async processing
│   └── lib/
│       ├── types.ts          # Type definitions
│       ├── pdf-render.ts     # Ghostscript rendering
│       ├── dynamo.ts         # DynamoDB helpers
│       ├── arke.ts           # Arke SDK helpers
│       └── file-utils.ts     # File detection
├── scripts/
│   ├── deploy.sh             # SAM deployment
│   └── create-table.sh       # DynamoDB setup
├── template.yaml             # SAM template with Ghostscript layer
└── package.json
```

## Testing

```bash
# Type check
npm run type-check

# Build
npm run build

# Deploy
./scripts/deploy.sh

# Test conversion
curl -X POST https://your-lambda.lambda-url.us-east-1.on.aws/start \
  -H "Content-Type: application/json" \
  -H "X-Lambda-Secret: your-secret" \
  -d '{
    "entity_id": "PDF_ENTITY_ID",
    "api_base": "https://arke-v1.arke.institute",
    "api_key": "ak_xxx",
    "network": "test",
    "options": { "quality": 90, "dpi": 150 }
  }'
```
