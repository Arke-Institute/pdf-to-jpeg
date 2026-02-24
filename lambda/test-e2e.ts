/**
 * E2E Test for PDF-to-JPEG Lambda
 *
 * Tests the full workflow:
 * 1. Create test collection
 * 2. Upload PDF as file entity
 * 3. Invoke Lambda with different modes
 * 4. Verify output entities and routing properties
 *
 * Usage:
 *   ARKE_USER_KEY=uk_xxx npx tsx test-e2e.ts <pdf-path> [mode]
 *
 * Modes: auto, render, extract
 */

import { readFileSync } from 'fs';
import { ArkeClient } from '@arke-institute/sdk';

const LAMBDA_URL = 'https://5cg7urvbu7uj5sgdehon3we4su0yiugy.lambda-url.us-east-1.on.aws/';
const LAMBDA_SECRET = '63c771e99dd8b87818f1d0ea0a22bcdcfad3f23ad80fb7106b294cafdfb1f9ed';
const API_BASE = 'https://arke-v1.arke.institute';
const NETWORK = 'test';

async function main() {
  const userKey = process.env.ARKE_USER_KEY;
  if (!userKey) {
    console.error('ARKE_USER_KEY environment variable required');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: ARKE_USER_KEY=uk_xxx npx tsx test-e2e.ts <pdf-path> [mode]');
    process.exit(1);
  }

  const pdfPath = args[0];
  const mode = (args[1] || 'auto') as 'auto' | 'render' | 'extract';

  console.log(`\n=== E2E Test: PDF Processing ===`);
  console.log(`PDF: ${pdfPath}`);
  console.log(`Mode: ${mode}`);
  console.log(`Lambda: ${LAMBDA_URL}\n`);

  // Create Arke client
  const client = new ArkeClient({
    baseUrl: API_BASE,
    authToken: userKey,
    network: NETWORK,
  });

  // Step 1: Create test collection
  console.log(`--- Step 1: Create test collection ---`);
  const { data: collection, error: collError } = await client.api.POST('/collections', {
    body: {
      label: `PDF Test ${mode} ${Date.now()}`,
    },
  });

  if (collError) {
    console.error('Failed to create collection:', collError);
    process.exit(1);
  }
  console.log(`Created collection: ${collection!.id}\n`);

  // Step 2: Upload PDF as file entity
  console.log(`--- Step 2: Upload PDF ---`);
  const pdfBuffer = readFileSync(pdfPath);
  const filename = pdfPath.split('/').pop() || 'test.pdf';

  // Create file entity
  const { data: fileEntity, error: fileError } = await client.api.POST('/entities', {
    body: {
      type: 'file',
      collection: collection!.id,
      properties: {
        filename,
        mime_type: 'application/pdf',
      },
    },
  });

  if (fileError) {
    console.error('Failed to create file entity:', fileError);
    process.exit(1);
  }
  console.log(`Created file entity: ${fileEntity!.id}`);

  // Upload content
  const uploadResponse = await fetch(
    `${API_BASE}/entities/${fileEntity!.id}/content?key=v1`,
    {
      method: 'POST',
      headers: {
        'Authorization': `ApiKey ${userKey}`,
        'Content-Type': 'application/pdf',
        'X-Arke-Network': NETWORK,
      },
      body: pdfBuffer,
    }
  );

  if (!uploadResponse.ok) {
    console.error('Failed to upload content:', await uploadResponse.text());
    process.exit(1);
  }
  console.log(`Uploaded ${(pdfBuffer.length / 1024).toFixed(1)} KB\n`);

  // Step 3: Invoke Lambda
  console.log(`--- Step 3: Invoke Lambda (mode=${mode}) ---`);
  const startPayload = {
    entity_id: fileEntity!.id,
    api_base: API_BASE,
    api_key: userKey,
    network: NETWORK,
    collection: collection!.id,
    options: { mode },
  };

  const startResponse = await fetch(`${LAMBDA_URL}start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lambda-Secret': LAMBDA_SECRET,
    },
    body: JSON.stringify(startPayload),
  });

  if (!startResponse.ok) {
    console.error('Failed to start job:', await startResponse.text());
    process.exit(1);
  }

  const startResult = await startResponse.json() as { success: boolean; job_id: string };
  console.log(`Job started: ${startResult.job_id}\n`);

  // Step 4: Poll for completion
  console.log(`--- Step 4: Wait for completion ---`);
  let status = 'pending';
  let result: Record<string, unknown> | null = null;

  while (status === 'pending' || status === 'processing') {
    await new Promise(r => setTimeout(r, 2000));

    const statusResponse = await fetch(`${LAMBDA_URL}status/${startResult.job_id}`, {
      headers: { 'X-Lambda-Secret': LAMBDA_SECRET },
    });
    const statusResult = await statusResponse.json() as {
      status: string;
      phase?: string;
      progress?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { code: string; message: string };
    };

    status = statusResult.status;
    const phase = statusResult.phase || '';
    const progress = statusResult.progress || {};

    console.log(`  Status: ${status}, Phase: ${phase}, Progress: ${JSON.stringify(progress)}`);

    if (status === 'done') {
      result = statusResult.result || null;
    } else if (status === 'error') {
      console.error('\nJob failed:', statusResult.error);
      process.exit(1);
    }
  }

  console.log(`\nJob completed!\n`);

  // Step 5: Verify results
  console.log(`--- Step 5: Verify results ---`);

  if (!result) {
    console.error('No result returned');
    process.exit(1);
  }

  const pages = result.pages as Array<{
    page_number: number;
    entity_id: string;
    needs_ocr: boolean;
    page_type: string;
    width: number;
    height: number;
    size_bytes: number;
  }>;

  console.log(`Total outputs: ${pages.length}`);
  console.log(`Source: ${result.source_id}`);
  console.log(`Total pages: ${result.total_pages}\n`);

  // Group by routing properties
  const textPages = pages.filter(p => p.page_type === 'text');
  const imagePages = pages.filter(p => p.page_type === 'image');

  console.log(`--- Routing Properties ---`);
  console.log(`Text pages: ${textPages.length} (needs_ocr: false)`);
  console.log(`Image pages: ${imagePages.length} (needs_ocr: true)\n`);

  // Verify routing properties
  let allCorrect = true;

  for (const page of textPages) {
    if (page.needs_ocr !== false) {
      console.error(`ERROR: Text page ${page.page_number} has needs_ocr=${page.needs_ocr}, expected false`);
      allCorrect = false;
    }
  }

  for (const page of imagePages) {
    if (page.needs_ocr !== true) {
      console.error(`ERROR: Image page ${page.page_number} has needs_ocr=${page.needs_ocr}, expected true`);
      allCorrect = false;
    }
  }

  // Show sample outputs
  console.log(`--- Sample outputs ---`);
  for (const page of pages.slice(0, 5)) {
    console.log(`  Page ${page.page_number}: ${page.page_type}, needs_ocr=${page.needs_ocr}, entity=${page.entity_id}`);
  }
  if (pages.length > 5) {
    console.log(`  ... and ${pages.length - 5} more`);
  }

  console.log();
  if (allCorrect) {
    console.log(`✓ All routing properties correct!`);
  } else {
    console.log(`✗ Some routing properties incorrect`);
    process.exit(1);
  }

  // Cleanup info
  console.log(`\n--- Cleanup ---`);
  console.log(`Collection: ${collection!.id}`);
  console.log(`To delete: curl -X DELETE "${API_BASE}/collections/${collection!.id}" -H "Authorization: ApiKey ${userKey.slice(0, 10)}..." -H "X-Arke-Network: ${NETWORK}"`);

  console.log(`\n=== Test Complete ===\n`);
}

main().catch(console.error);
