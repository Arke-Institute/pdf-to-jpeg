/**
 * Process Handler - Async job processing
 *
 * Invoked via Lambda.invoke with { action: 'process', job_id: string }
 */

import type { PdfJob } from '../lib/types.js';
import { getJob, createProcessContext } from '../lib/dynamo.js';
import { processJob } from '../job.js';

const MAX_RETRIES = 3;

/**
 * Handle async process invocation
 */
export async function handleProcess(jobId: string): Promise<void> {
  console.log(`[process] Starting processing for job ${jobId}`);

  // Get job from DynamoDB
  const job = await getJob<PdfJob>(jobId);

  if (!job) {
    console.error(`[process] Job not found: ${jobId}`);
    return;
  }

  // Check if already completed
  if (job.status === 'done') {
    console.log(`[process] Job ${jobId} already complete, skipping`);
    return;
  }

  // Check retry limit
  if (job.status === 'error' && job.retry_count >= MAX_RETRIES) {
    console.log(`[process] Job ${jobId} has failed ${job.retry_count} times, not retrying`);
    return;
  }

  // Create process context with helper methods
  const ctx = createProcessContext(job);

  try {
    // Update status to processing
    await ctx.updateStatus('processing', 'starting');

    // Run the processor's job function
    // NOTE: Implement processJob in src/job.ts for your processor
    const result = await processJob(ctx);

    // Complete the job with result
    await ctx.complete(result?.result);

    console.log(`[process] Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[process] Job ${jobId} failed:`, error);

    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = extractErrorCode(message);

    await ctx.fail(code, message);
  }
}

/**
 * Extract error code from error message
 */
function extractErrorCode(message: string): string {
  // Check for known error codes at start of message
  const knownCodes = [
    'FILE_NOT_FOUND',
    'FILE_TOO_LARGE',
    'UNSUPPORTED_TYPE',
    'DOWNLOAD_FAILED',
    'NO_CONTENT',
    'PROCESSING_ERROR',
  ];

  for (const code of knownCodes) {
    if (message.startsWith(code)) {
      return code;
    }
  }

  return 'PROCESSING_ERROR';
}
