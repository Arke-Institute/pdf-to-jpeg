/**
 * Performance test for PDF-to-JPEG parallel rendering
 *
 * Tests with a large PDF and force render mode to benchmark parallel Ghostscript.
 *
 * Usage:
 *   ARKE_USER_KEY=uk_... KLADOS_ID=... npx tsx test/perf-test.ts
 */

import {
  configureTestClient,
  createCollection,
  createEntity,
  invokeKlados,
  waitForKladosLog,
  getConfig,
  log,
} from '@arke-institute/klados-testing';
import { readFileSync } from 'fs';

const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const NETWORK = (process.env.ARKE_NETWORK || 'test') as 'test' | 'main';
const KLADOS_ID = process.env.KLADOS_ID;

// User's large PDF
const PDF_PATH = process.env.PDF_PATH || '/Users/chim/Downloads/biblestoriesfory00newy (1).pdf';

async function uploadEntityContent(
  entityId: string,
  content: ArrayBuffer,
  contentType: string,
  key: string = 'v1'
): Promise<void> {
  const config = getConfig();
  const url = `${config.apiBase}/entities/${entityId}/content?key=${encodeURIComponent(key)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `ApiKey ${config.userKey}`,
      'X-Arke-Network': config.network,
      'Content-Type': contentType,
    },
    body: content,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload content: ${response.status} - ${text}`);
  }
}

async function main() {
  if (!ARKE_USER_KEY) {
    console.error('ARKE_USER_KEY not set');
    process.exit(1);
  }
  if (!KLADOS_ID) {
    console.error('KLADOS_ID not set');
    process.exit(1);
  }

  configureTestClient({
    apiBase: ARKE_API_BASE,
    userKey: ARKE_USER_KEY,
    network: NETWORK,
  });

  log(`Performance test for PDF-to-JPEG parallel rendering`);
  log(`PDF: ${PDF_PATH}`);
  log(`Klados: ${KLADOS_ID}`);

  // Read PDF
  log('Reading PDF...');
  const pdfBuffer = readFileSync(PDF_PATH);
  const pdfContent = pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength);
  log(`PDF size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  // Create collection
  log('Creating test collection...');
  const collection = await createCollection({
    label: `Perf Test ${Date.now()}`,
    roles: { public: ['*:view', '*:invoke', '*:create', '*:update'] },
  });
  log(`Collection: ${collection.id}`);

  // Create entity
  log('Creating PDF entity...');
  const entity = await createEntity({
    type: 'file',
    properties: {
      label: 'Bible Stories (Large PDF)',
      filename: 'biblestoriesfory00newy.pdf',
    },
    collection: collection.id,
  });
  log(`Entity: ${entity.id}`);

  // Upload PDF
  log('Uploading PDF content...');
  await uploadEntityContent(entity.id, pdfContent, 'application/pdf');
  log('Upload complete');

  // Invoke klados with RENDER mode forced
  log('');
  log('=== Starting performance test ===');
  log('Forcing RENDER mode to test parallel Ghostscript...');

  const startTime = Date.now();

  const result = await invokeKlados({
    kladosId: KLADOS_ID,
    targetEntity: entity.id,
    targetCollection: collection.id,
    confirm: true,
    input: {
      options: {
        mode: 'render',  // Force render mode to use parallel GS
        dpi: 150,        // Lower DPI for faster test
        quality: 80,
      },
    },
  });

  log(`Job started: ${result.job_id}`);
  log(`Job collection: ${result.job_collection}`);

  // Wait for completion
  log('');
  log('Waiting for completion...');
  const kladosLog = await waitForKladosLog(result.job_collection!, {
    timeout: 600000, // 10 minutes for large PDF
    pollInterval: 5000,
    onPoll: (elapsed) => {
      log(`  Polling... ${Math.round(elapsed / 1000)}s elapsed`);
    },
  });

  const totalTime = Date.now() - startTime;

  log('');
  log('=== Results ===');
  log(`Status: ${kladosLog.properties.status}`);
  log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);

  // Log messages
  log('');
  log('Log messages:');
  for (const msg of kladosLog.properties.log_data?.messages || []) {
    log(`  [${msg.level}] ${msg.message}`);
  }

  // Summary
  const entityCount = kladosLog.properties.log_data?.messages?.find(
    (m: { level: string }) => m.level === 'success'
  )?.metadata?.entity_count || 0;

  log('');
  log('Summary:');
  log(`  Pages converted: ${entityCount}`);
  log(`  Time per page: ${entityCount > 0 ? (totalTime / 1000 / entityCount).toFixed(1) : 'N/A'}s`);
  log(`  Collection: ${collection.id}`);
  log(`  Entity: ${entity.id}`);
}

main().catch(console.error);
