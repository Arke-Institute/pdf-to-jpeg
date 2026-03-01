/**
 * Arke SDK helpers for file processing
 *
 * Provides ArkeClient factory and common entity/file operations.
 */

import { ArkeClient } from '@arke-institute/sdk';
import type { BaseJob } from './types.js';

// =============================================================================
// Client Factory
// =============================================================================

/**
 * Create ArkeClient from job credentials
 */
export function createArkeClient(job: BaseJob): ArkeClient {
  return new ArkeClient({
    baseUrl: job.api_base,
    authToken: job.api_key,
    network: job.network,
  });
}

// =============================================================================
// Entity Operations
// =============================================================================

/**
 * Get entity by ID
 */
export async function getEntity(
  client: ArkeClient,
  entityId: string
): Promise<{
  id: string;
  cid: string;
  type: string;
  properties: Record<string, unknown>;
  relationships?: Array<{ predicate: string; peer: string; peer_type?: string }>;
}> {
  const { data, error } = await client.api.GET('/entities/{id}', {
    params: { path: { id: entityId } },
  });

  if (error || !data) {
    throw new Error(`Failed to get entity ${entityId}: ${JSON.stringify(error)}`);
  }

  return {
    id: data.id,
    cid: data.cid,
    type: data.type,
    properties: (data.properties as Record<string, unknown>) || {},
    relationships: data.relationships as Array<{ predicate: string; peer: string; peer_type?: string }> | undefined,
  };
}

/**
 * Get entity tip (CID) for CAS-safe updates
 */
export async function getEntityTip(
  client: ArkeClient,
  entityId: string
): Promise<string> {
  const { data, error } = await client.api.GET('/entities/{id}/tip', {
    params: { path: { id: entityId } },
  });

  if (error || !data) {
    throw new Error(`Failed to get tip for ${entityId}: ${JSON.stringify(error)}`);
  }

  return data.cid;
}

/**
 * Create entity with optional relationships
 */
export async function createEntity(
  client: ArkeClient,
  params: {
    type: string;
    collection?: string;
    properties?: Record<string, unknown>;
    relationships?: Array<{
      predicate: string;
      peer: string;
      peer_type?: string;
    }>;
  }
): Promise<{ id: string; cid: string }> {
  const { data, error } = await client.api.POST('/entities', {
    body: {
      type: params.type,
      collection: params.collection,
      properties: params.properties,
      relationships: params.relationships,
    },
  });

  if (error || !data) {
    throw new Error(`Failed to create entity: ${JSON.stringify(error)}`);
  }

  return { id: data.id, cid: data.cid };
}

/**
 * Update entity with CAS safety (auto-retry on conflict)
 */
export async function updateEntity(
  client: ArkeClient,
  entityId: string,
  updates: {
    properties?: Record<string, unknown>;
    relationships_add?: Array<{
      predicate: string;
      peer: string;
      peer_type?: string;
    }>;
    relationships_remove?: Array<{
      predicate: string;
      peer: string;
    }>;
  },
  maxRetries: number = 3
): Promise<void> {
  let cid = await getEntityTip(client, entityId);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { error } = await client.api.PUT('/entities/{id}', {
      params: { path: { id: entityId } },
      body: {
        expect_tip: cid,
        ...updates,
      },
    });

    if (!error) return;

    const errorStr = JSON.stringify(error);
    const isConflict = errorStr.includes('409') ||
      errorStr.includes('Conflict') ||
      errorStr.includes('cas') ||
      errorStr.includes('expect_tip');

    if (isConflict && attempt < maxRetries - 1) {
      console.log(`[arke] CAS conflict updating ${entityId}, retrying (${attempt + 1}/${maxRetries})...`);
      cid = await getEntityTip(client, entityId);
      const delay = Math.pow(2, attempt) * 200 + Math.random() * 200;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    throw new Error(`Failed to update entity ${entityId}: ${errorStr}`);
  }
}

// =============================================================================
// File Operations
// =============================================================================

/**
 * Create file entity
 */
export async function createFileEntity(
  client: ArkeClient,
  params: {
    filename: string;
    contentType: string;
    size: number;
    collection?: string;
    properties?: Record<string, unknown>;
    relationships?: Array<{
      predicate: string;
      peer: string;
      peer_type?: string;
    }>;
  }
): Promise<{ id: string; cid: string }> {
  const { data, error } = await client.api.POST('/entities', {
    body: {
      type: 'file',
      collection: params.collection,
      properties: {
        filename: params.filename,
        mime_type: params.contentType,
        ...params.properties,
      },
      relationships: params.relationships,
    },
  });

  if (error || !data) {
    throw new Error(`Failed to create file entity: ${JSON.stringify(error)}`);
  }

  return { id: data.id, cid: data.cid };
}

/**
 * Upload content to file entity
 *
 * Uses direct HTTP fetch since SDK may have issues.
 */
export async function uploadFileContent(
  client: ArkeClient,
  fileId: string,
  content: Buffer,
  contentType: string
): Promise<void> {
  // Extract config from client - try multiple possible property names
  const clientAny = client as unknown as Record<string, unknown>;
  const config = (clientAny.config || clientAny.options || clientAny) as Record<string, unknown>;

  const baseUrl = (config.baseUrl || clientAny.baseUrl || 'https://arke-v1.arke.institute') as string;
  const authToken = (config.authToken || clientAny.authToken) as string;
  const network = (config.network || clientAny.network) as string;

  console.log(`[uploadFileContent] baseUrl=${baseUrl}, hasAuthToken=${!!authToken}, network=${network}`);

  const key = `v1`;  // Default content key
  const url = `${baseUrl}/entities/${fileId}/content?key=${encodeURIComponent(key)}`;

  const headers: Record<string, string> = {
    'Authorization': `ApiKey ${authToken}`,
    'Content-Type': contentType,
    'Content-Length': content.length.toString(),
  };

  if (network) {
    headers['X-Arke-Network'] = network;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: content,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload file content: ${errorText}`);
  }
}

/**
 * Download file content
 */
export async function downloadFileContent(
  client: ArkeClient,
  fileId: string
): Promise<Buffer> {
  const { data, error } = await client.getFileContentAsArrayBuffer(fileId);

  if (error || !data) {
    throw new Error(`Failed to download file: ${JSON.stringify(error)}`);
  }

  return Buffer.from(data);
}

/**
 * Create file entity and upload content in one operation
 */
export async function createAndUploadFile(
  client: ArkeClient,
  params: {
    filename: string;
    content: Buffer;
    contentType: string;
    collection?: string;
    properties?: Record<string, unknown>;
    relationships?: Array<{
      predicate: string;
      peer: string;
      peer_type?: string;
    }>;
  }
): Promise<{ id: string; cid: string }> {
  // Create file entity
  const { id } = await createFileEntity(client, {
    filename: params.filename,
    contentType: params.contentType,
    size: params.content.length,
    collection: params.collection,
    properties: params.properties,
    relationships: params.relationships,
  });

  // Upload content
  await uploadFileContent(client, id, params.content, params.contentType);

  // Get updated CID after upload
  const cid = await getEntityTip(client, id);

  return { id, cid };
}

// =============================================================================
// Relationship Operations
// =============================================================================

/**
 * Create bidirectional relationship between two entities
 */
export async function createBidirectionalRelationship(
  client: ArkeClient,
  params: {
    sourceId: string;
    targetId: string;
    sourcePredicate: string;  // e.g., 'derived_from'
    targetPredicate: string;  // e.g., 'has_derivative'
  },
  maxRetries: number = 3
): Promise<void> {
  let [sourceCid, targetCid] = await Promise.all([
    getEntityTip(client, params.sourceId),
    getEntityTip(client, params.targetId),
  ]);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { error } = await client.api.POST('/relationships', {
      body: {
        source_id: params.sourceId,
        target_id: params.targetId,
        source_predicate: params.sourcePredicate,
        target_predicate: params.targetPredicate,
        expect_source_tip: sourceCid,
        expect_target_tip: targetCid,
      },
    });

    if (!error) return;

    const errorStr = JSON.stringify(error);
    const isConflict = errorStr.includes('409') ||
      errorStr.includes('Conflict') ||
      errorStr.includes('cas') ||
      errorStr.includes('expect_tip');

    if (isConflict && attempt < maxRetries - 1) {
      console.log(`[arke] CAS conflict creating relationship, retrying (${attempt + 1}/${maxRetries})...`);
      [sourceCid, targetCid] = await Promise.all([
        getEntityTip(client, params.sourceId),
        getEntityTip(client, params.targetId),
      ]);
      const delay = Math.pow(2, attempt) * 200 + Math.random() * 200;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    throw new Error(`Failed to create relationship: ${errorStr}`);
  }
}

/**
 * Add relationship to entity (one direction only)
 */
export async function addRelationship(
  client: ArkeClient,
  entityId: string,
  relationship: {
    predicate: string;
    peer: string;
    peer_type?: string;
  }
): Promise<void> {
  await updateEntity(client, entityId, {
    relationships_add: [relationship],
  });
}

// =============================================================================
// Optimized Batch Operations
// =============================================================================

/**
 * Extract client configuration for direct HTTP calls
 */
function extractClientConfig(client: ArkeClient): {
  baseUrl: string;
  authToken: string;
  network?: string;
} {
  const clientAny = client as unknown as Record<string, unknown>;
  const config = (clientAny.config || clientAny.options || clientAny) as Record<string, unknown>;

  return {
    baseUrl: (config.baseUrl || clientAny.baseUrl || 'https://arke-v1.arke.institute') as string,
    authToken: (config.authToken || clientAny.authToken) as string,
    network: (config.network || clientAny.network) as string | undefined,
  };
}

/**
 * Batch result from API
 */
interface BatchCreateResult {
  success: boolean;
  index: number;
  id?: string;
  cid?: string;
  error?: string;
  code?: string;
}

/**
 * Batch create file entities
 *
 * Uses POST /entities/batch for efficient bulk creation.
 * Automatically chunks into batches of 100 (API limit).
 * Entities are created without content - upload content separately.
 */
export async function batchCreateFileEntities(
  client: ArkeClient,
  entities: Array<{
    filename: string;
    contentType: string;
    collection?: string;
    properties?: Record<string, unknown>;
    relationships?: Array<{ predicate: string; peer: string; peer_type?: string }>;
  }>
): Promise<Array<{ id: string; cid: string; index: number }>> {
  if (entities.length === 0) {
    return [];
  }

  const { baseUrl, authToken, network } = extractClientConfig(client);
  const collection = entities[0]?.collection;
  const BATCH_SIZE = 100;

  console.log(`[batchCreateFileEntities] Creating ${entities.length} entities in batches of ${BATCH_SIZE}`);

  const headers: Record<string, string> = {
    'Authorization': `ApiKey ${authToken}`,
    'Content-Type': 'application/json',
  };

  if (network) {
    headers['X-Arke-Network'] = network;
  }

  const allResults: Array<{ id: string; cid: string; index: number }> = [];

  // Process in chunks of BATCH_SIZE
  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const chunk = entities.slice(i, i + BATCH_SIZE);
    const chunkNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalChunks = Math.ceil(entities.length / BATCH_SIZE);

    console.log(`[batchCreateFileEntities] Processing batch ${chunkNum}/${totalChunks} (${chunk.length} entities)`);

    const response = await fetch(`${baseUrl}/entities/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        default_collection: collection,
        entities: chunk.map(e => ({
          type: 'file',
          properties: {
            filename: e.filename,
            mime_type: e.contentType,
            ...e.properties,
          },
          relationships: e.relationships,
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Batch create failed (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { results: BatchCreateResult[] };

    // Check for failures
    const failures = data.results.filter((r: BatchCreateResult) => !r.success);
    if (failures.length > 0) {
      console.error(`[batchCreateFileEntities] ${failures.length} entities failed:`, failures);
      throw new Error(`Batch create had ${failures.length} failures: ${JSON.stringify(failures[0])}`);
    }

    const results = data.results
      .filter((r: BatchCreateResult) => r.success && r.id && r.cid)
      .map((r: BatchCreateResult) => ({
        id: r.id!,
        cid: r.cid!,
        index: r.index + i, // Adjust index for global position
      }));

    allResults.push(...results);
  }

  console.log(`[batchCreateFileEntities] Created ${allResults.length} entities total`);
  return allResults;
}

/**
 * Parallel upload content to multiple entities
 *
 * Uses bounded concurrency to avoid overwhelming the API.
 */
export async function parallelUploadContent(
  client: ArkeClient,
  uploads: Array<{ entityId: string; content: Buffer; contentType: string }>,
  concurrency: number = 25
): Promise<void> {
  if (uploads.length === 0) {
    return;
  }

  // Dynamic import for p-limit (ESM module)
  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(concurrency);

  console.log(`[parallelUploadContent] Uploading ${uploads.length} files with concurrency ${concurrency}`);

  const results = await Promise.allSettled(
    uploads.map((upload, i) =>
      limit(async () => {
        await uploadFileContent(client, upload.entityId, upload.content, upload.contentType);
        if ((i + 1) % 10 === 0) {
          console.log(`[parallelUploadContent] Uploaded ${i + 1}/${uploads.length}`);
        }
      })
    )
  );

  // Check for failures
  const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  if (failures.length > 0) {
    console.error(`[parallelUploadContent] ${failures.length} uploads failed`);
    throw new Error(`Parallel upload had ${failures.length} failures: ${failures[0].reason}`);
  }

  console.log(`[parallelUploadContent] All ${uploads.length} uploads complete`);
}
