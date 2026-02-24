/**
 * PDF-to-JPEG Klados E2E Test
 *
 * Tests the PDF-to-JPEG conversion workflow:
 * 1. Creates a PDF file entity with actual PDF content
 * 2. Invokes the klados to convert pages to JPEG
 * 3. Verifies JPEG entities are created with proper relationships
 *
 * Prerequisites:
 * 1. Deploy Lambda: cd ../lambda && ./scripts/deploy.sh
 * 2. Deploy worker: npm run deploy
 * 3. Register klados: npm run register
 * 4. Set environment variables
 *
 * Environment variables:
 *   ARKE_USER_KEY   - Your Arke user API key (uk_...)
 *   KLADOS_ID       - The klados entity ID from registration
 *   ARKE_API_BASE   - API base URL (default: https://arke-v1.arke.institute)
 *   ARKE_NETWORK    - Network to use (default: test)
 *
 * Usage:
 *   ARKE_USER_KEY=uk_... KLADOS_ID=klados_... npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  configureTestClient,
  createCollection,
  createEntity,
  deleteEntity,
  getEntity,
  invokeKlados,
  waitForKladosLog,
  assertLogCompleted,
  getConfig,
  log,
} from '@arke-institute/klados-testing';

// =============================================================================
// Configuration
// =============================================================================

const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const NETWORK = (process.env.ARKE_NETWORK || 'test') as 'test' | 'main';
const KLADOS_ID = process.env.KLADOS_ID;

import { readFileSync } from 'fs';
import { join } from 'path';

// Local test PDF (8 pages)
const SAMPLE_PDF_PATH = '/Users/chim/Downloads/The Tradecraft of Filling in the Gaps_ How Intelligence Analysts Reconstruct Hidden Information.pdf';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Upload binary content to an entity
 */
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

/**
 * Read a local file as ArrayBuffer
 */
function readLocalFile(path: string): ArrayBuffer {
  const buffer = readFileSync(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

// =============================================================================
// Test Suite
// =============================================================================

describe('pdf-to-jpeg-worker', () => {
  // Test fixtures
  let targetCollection: { id: string };
  let pdfEntity: { id: string };
  let jobCollectionId: string;
  let createdEntityIds: string[] = [];

  // Skip tests if environment not configured
  beforeAll(() => {
    if (!ARKE_USER_KEY) {
      console.warn('Skipping tests: ARKE_USER_KEY not set');
      return;
    }
    if (!KLADOS_ID) {
      console.warn('Skipping tests: KLADOS_ID not set');
      return;
    }

    // Configure the test client
    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });

    log(`Using klados: ${KLADOS_ID}`);
  });

  // Create test fixtures
  beforeAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Creating test fixtures...');

    // Create target collection with permissions for klados to create entities
    targetCollection = await createCollection({
      label: `PDF-to-JPEG Test ${Date.now()}`,
      description: 'Test collection for PDF-to-JPEG conversion',
      roles: {
        public: ['*:view', '*:invoke', '*:create', '*:update'],
      },
    });
    log(`Created target collection: ${targetCollection.id}`);

    // Create PDF file entity
    pdfEntity = await createEntity({
      type: 'file',
      properties: {
        label: 'Test PDF Document',
        filename: 'test-document.pdf',
      },
      collection: targetCollection.id,
    });
    log(`Created PDF entity: ${pdfEntity.id}`);

    // Read local PDF file
    log('Reading local PDF file...');
    const pdfContent = readLocalFile(SAMPLE_PDF_PATH);
    log(`Read PDF: ${pdfContent.byteLength} bytes (8 pages)`);

    log('Uploading PDF content to entity...');
    await uploadEntityContent(pdfEntity.id, pdfContent, 'application/pdf');
    log('PDF content uploaded');
  });

  // Cleanup test fixtures
  afterAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    // Disable cleanup for debugging
    log('Cleanup DISABLED for inspection');
    log(`  Target collection: ${targetCollection?.id}`);
    log(`  PDF entity: ${pdfEntity?.id}`);
    log(`  Job collection: ${jobCollectionId}`);
    log(`  Created entities: ${createdEntityIds.join(', ')}`);

    // Uncomment to enable cleanup:
    // try {
    //   for (const id of createdEntityIds) {
    //     await deleteEntity(id);
    //   }
    //   if (pdfEntity?.id) await deleteEntity(pdfEntity.id);
    //   if (targetCollection?.id) await deleteEntity(targetCollection.id);
    //   log('Cleanup complete');
    // } catch (e) {
    //   log(`Cleanup error (non-fatal): ${e}`);
    // }
  });

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('should convert PDF pages to JPEG entities', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Invoke the klados
    log('Invoking PDF-to-JPEG klados...');
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: pdfEntity.id,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');
    expect(result.job_id).toBeDefined();
    expect(result.job_collection).toBeDefined();

    jobCollectionId = result.job_collection!;
    log(`Job started: ${result.job_id}`);
    log(`Job collection: ${jobCollectionId}`);

    // Wait for completion - Lambda processing can take a while
    log('Waiting for job completion (Lambda processing may take 30-60 seconds)...');
    const kladosLog = await waitForKladosLog(jobCollectionId, {
      timeout: 120000, // 2 minutes for Lambda cold start + processing
      pollInterval: 5000,
      onPoll: (elapsed) => {
        log(`  Polling... ${Math.round(elapsed / 1000)}s elapsed`);
      },
    });

    // Verify log completed successfully
    assertLogCompleted(kladosLog);
    log(`Job completed with status: ${kladosLog.properties.status}`);

    // Log all messages for debugging
    log('Log messages:');
    for (const msg of kladosLog.properties.log_data?.messages || []) {
      log(`  [${msg.level}] ${msg.message}`);
    }

    // Extract entity count from success message metadata
    const successMsg = kladosLog.properties.log_data?.messages?.find(
      (m: { level: string }) => m.level === 'success'
    );
    const entityCount = successMsg?.metadata?.entity_count || 0;
    log(`Klados reported creating ${entityCount} entities`);
    expect(entityCount).toBeGreaterThan(0);

    // Verify output entities by querying the target collection for JPEG files
    // The worker creates entities with source_entity_id pointing to the PDF
    const config = getConfig();
    const response = await fetch(
      `${config.apiBase}/collections/${targetCollection.id}/entities?type=file`,
      {
        headers: {
          'Authorization': `ApiKey ${config.userKey}`,
          'X-Arke-Network': config.network,
        },
      }
    );
    const collectionData = await response.json() as { entities: Array<{ id: string }> };

    // Filter for JPEG entities created from our PDF
    const jpegEntities: Array<{ id: string }> = [];
    for (const entity of collectionData.entities || []) {
      const entityDetails = await getEntity(entity.id);
      if (entityDetails.properties?.source_entity_id === pdfEntity.id) {
        jpegEntities.push(entityDetails);
      }
    }

    log(`Found ${jpegEntities.length} JPEG entities derived from PDF`);
    expect(jpegEntities.length).toBe(entityCount);

    createdEntityIds = jpegEntities.map((e: { id: string }) => e.id);

    // Verify first output entity has expected properties
    if (jpegEntities.length > 0) {
      const firstPage = jpegEntities.find(
        (e: { properties?: { page_number?: number } }) => e.properties?.page_number === 1
      ) as { id: string; type: string; properties: Record<string, unknown>; relationships?: Array<{ predicate: string; peer: string }> };
      expect(firstPage).toBeDefined();
      log(`First page entity: ${firstPage.id}`);
      log(`  Type: ${firstPage.type}`);
      log(`  Properties: ${JSON.stringify(firstPage.properties)}`);

      expect(firstPage.type).toBe('file');
      expect(firstPage.properties.page_number).toBe(1);
      expect(firstPage.properties.source_entity_id).toBe(pdfEntity.id);
      expect(firstPage.properties.width).toBeGreaterThan(0);
      expect(firstPage.properties.height).toBeGreaterThan(0);

      // Check relationship to source
      const relationships = firstPage.relationships || [];
      const derivedFrom = relationships.find(
        (r: { predicate: string }) => r.predicate === 'derived_from'
      );
      expect(derivedFrom).toBeDefined();
      expect(derivedFrom?.peer).toBe(pdfEntity.id);
    }

    log('PDF-to-JPEG conversion completed successfully!');
  }, 180000); // 3 minute test timeout

  it('should handle preview mode (confirm=false)', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Preview invocation (confirm=false)
    const preview = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: pdfEntity.id,
      targetCollection: targetCollection.id,
      confirm: false,
    });

    // Preview should return pending_confirmation status
    expect(preview.status).toBe('pending_confirmation');
    log(`Preview result: ${preview.status}`);
  });

  it('should reject non-PDF entities', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Create a non-PDF entity (text file)
    const textEntity = await createEntity({
      type: 'file',
      properties: {
        label: 'Test Text File',
        filename: 'test.txt',
      },
      collection: targetCollection.id,
    });

    // Upload text content
    const textContent = new TextEncoder().encode('This is not a PDF');
    await uploadEntityContent(textEntity.id, textContent.buffer, 'text/plain');

    // Invoke should start but Lambda should fail
    log('Invoking klados with non-PDF entity...');
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: textEntity.id,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');

    // Wait for error
    const kladosLog = await waitForKladosLog(result.job_collection!, {
      timeout: 120000,
      pollInterval: 5000,
    });

    // Should fail with error
    expect(kladosLog.properties.status).toBe('error');
    log(`Expected error status: ${kladosLog.properties.status}`);

    // Cleanup
    await deleteEntity(textEntity.id);
  }, 180000);
});
