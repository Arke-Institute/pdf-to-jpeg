/**
 * PDF-to-JPEG Job Processing Logic
 *
 * This worker orchestrates PDF to JPEG conversion by:
 * 1. Starting a job on the Lambda backend
 * 2. Polling for completion using DO alarms
 * 3. Returning the output entity IDs for workflow handoff
 */

import type { KladosJob, Output } from '@arke-institute/rhiza';
import type { Env, TargetProperties } from './types.js';
import { LambdaClient } from './lambda-client.js';

/**
 * Context provided to processJob
 */
export interface ProcessContext {
  /** KladosJob instance (provides client, logger, request, fetchTarget, etc.) */
  job: KladosJob;

  /** SQLite storage for checkpointing long operations */
  sql: SqlStorage;

  /** Worker environment bindings (secrets, vars, DO namespaces) */
  env: Env;
}

/**
 * Result returned from processJob
 */
export interface ProcessResult {
  /** Output entity IDs (or OutputItems with routing properties) */
  outputs?: Output[];

  /** If true, DO will reschedule alarm and call processJob again */
  reschedule?: boolean;
}

/**
 * Process a PDF-to-JPEG conversion job
 *
 * Uses Lambda polling pattern:
 * - First call: Start Lambda job, store job_id, reschedule
 * - Subsequent calls: Poll status, reschedule if pending
 * - Final call: Return output entity IDs
 */
export async function processJob(ctx: ProcessContext): Promise<ProcessResult> {
  const { job, sql, env } = ctx;
  const { request, log: logger } = job;
  const authToken = job.config.authToken!;

  // =========================================================================
  // Initialize poll state table
  // =========================================================================

  sql.exec(`
    CREATE TABLE IF NOT EXISTS poll_state (
      id INTEGER PRIMARY KEY,
      lambda_job_id TEXT NOT NULL,
      poll_count INTEGER DEFAULT 0,
      started_at TEXT NOT NULL
    )
  `);

  const state = sql.exec('SELECT * FROM poll_state WHERE id = 1').toArray()[0];

  // Create Lambda client
  const lambdaClient = new LambdaClient(env.LAMBDA_URL, env.LAMBDA_SECRET);

  // =========================================================================
  // First run - Start Lambda job
  // =========================================================================

  if (!state) {
    logger.info('Starting Lambda job', {
      target: request.target_entity,
      isWorkflow: !!request.rhiza,
    });

    if (!request.target_entity) {
      throw new Error('No target_entity in request');
    }

    // Extract properties from request.input
    const inputProps = (request.input || {}) as TargetProperties;

    // Start Lambda job
    const result = await lambdaClient.startJob({
      entity_id: request.target_entity,
      api_base: request.api_base,
      api_key: authToken, // Use agent's auth token
      network: request.network,
      collection: request.target_collection,
      target_file_key: inputProps.target_file_key,
      options: inputProps.options,
    });

    // Store job ID for polling
    sql.exec(
      'INSERT INTO poll_state (id, lambda_job_id, poll_count, started_at) VALUES (1, ?, 0, ?)',
      result.job_id,
      new Date().toISOString()
    );

    logger.info(`Started Lambda job: ${result.job_id}`);

    return { reschedule: true };
  }

  // =========================================================================
  // Subsequent runs - Poll for completion
  // =========================================================================

  const lambdaJobId = state.lambda_job_id as string;
  const pollCount = (state.poll_count as number) + 1;

  // Poll Lambda status
  const status = await lambdaClient.getStatus(lambdaJobId);

  // Still processing - reschedule
  if (status.status === 'pending' || status.status === 'processing') {
    sql.exec('UPDATE poll_state SET poll_count = ? WHERE id = 1', pollCount);

    const progress = status.progress;
    const pagesInfo = progress.total_pages
      ? `${progress.pages_rendered || 0}/${progress.total_pages} pages`
      : 'starting';

    logger.info(`Poll #${pollCount}: ${status.phase} (${pagesInfo})`);

    return { reschedule: true };
  }

  // Error - clean up and throw
  if (status.status === 'error') {
    sql.exec('DELETE FROM poll_state WHERE id = 1');

    const errorCode = status.error?.code || 'UNKNOWN';
    const errorMessage = status.error?.message || 'Unknown error';

    throw new Error(`Lambda error [${errorCode}]: ${errorMessage}`);
  }

  // =========================================================================
  // Success - Return output entity IDs
  // =========================================================================

  sql.exec('DELETE FROM poll_state WHERE id = 1');

  const totalPages = status.result?.total_pages || 0;
  const outputs = status.result?.outputs || status.result?.pages || [];

  logger.success(`Completed: ${totalPages} pages processed`, {
    output_count: outputs.length,
    poll_count: pollCount,
  });

  return {
    outputs: outputs.map((item) => ({
      entity_id: item.entity_id,
      needs_ocr: item.needs_ocr,
      page_type: item.page_type,
    })),
  };
}
