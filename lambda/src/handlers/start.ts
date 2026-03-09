/**
 * Start Handler - Creates async job and invokes processing
 *
 * POST /start
 * Returns immediately with job_id, processing happens in background
 */

import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import type { StartInput, StartResponse, PdfJob, PdfProgress, PdfToJpegOptions, ProcessingMode } from '../lib/types.js';
import { createJob, generateJobId } from '../lib/dynamo.js';

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Default options
const DEFAULT_MODE: ProcessingMode = 'auto';
const DEFAULT_QUALITY = 85;
const DEFAULT_DPI = 300;
const DEFAULT_MAX_DIMENSION = 2400;
const DEFAULT_PAGE_GROUP_SIZE = 3;

/**
 * Validate start input
 */
function validateInput(input: unknown): StartInput {
  const data = input as Record<string, unknown>;

  if (!data.entity_id || typeof data.entity_id !== 'string') {
    throw new Error('entity_id is required');
  }
  if (!data.api_base || typeof data.api_base !== 'string') {
    throw new Error('api_base is required');
  }
  if (!data.api_key || typeof data.api_key !== 'string') {
    throw new Error('api_key is required');
  }
  if (!data.network || (data.network !== 'test' && data.network !== 'main')) {
    throw new Error('network must be "test" or "main"');
  }

  return {
    entity_id: data.entity_id,
    api_base: data.api_base,
    api_key: data.api_key,
    network: data.network,
    collection: data.collection as string | undefined,
    target_file_key: data.target_file_key as string | undefined,
    options: data.options as Record<string, unknown> | undefined,
  };
}

/**
 * Extract and validate PDF options from input
 */
function extractPdfOptions(options?: Record<string, unknown>): {
  mode: ProcessingMode;
  quality: number;
  dpi: number;
  max_dimension: number;
  page_group_size: number;
} {
  const pdfOpts = (options || {}) as PdfToJpegOptions;

  // Validate mode
  let mode = DEFAULT_MODE;
  if (pdfOpts.mode === 'auto' || pdfOpts.mode === 'render' || pdfOpts.mode === 'extract') {
    mode = pdfOpts.mode;
  }

  let quality = DEFAULT_QUALITY;
  if (typeof pdfOpts.quality === 'number') {
    quality = Math.max(1, Math.min(100, pdfOpts.quality));
  }

  let dpi = DEFAULT_DPI;
  if (typeof pdfOpts.dpi === 'number') {
    dpi = Math.max(72, Math.min(600, pdfOpts.dpi));
  }

  let max_dimension = DEFAULT_MAX_DIMENSION;
  if (typeof pdfOpts.max_dimension === 'number') {
    max_dimension = Math.max(100, Math.min(10000, pdfOpts.max_dimension));
  }

  let page_group_size = DEFAULT_PAGE_GROUP_SIZE;
  if (typeof pdfOpts.page_group_size === 'number') {
    page_group_size = Math.max(0, Math.min(20, pdfOpts.page_group_size));
  }

  return { mode, quality, dpi, max_dimension, page_group_size };
}

/**
 * Handle POST /start request
 */
export async function handleStart(input: unknown): Promise<StartResponse> {
  // Validate input
  const validatedInput = validateInput(input);
  const jobId = generateJobId();
  const pdfOptions = extractPdfOptions(validatedInput.options);

  console.log(`[start] Creating job ${jobId} for entity ${validatedInput.entity_id}`);
  console.log(`[start] Options: mode=${pdfOptions.mode}, quality=${pdfOptions.quality}, dpi=${pdfOptions.dpi}, max_dimension=${pdfOptions.max_dimension}, page_group_size=${pdfOptions.page_group_size}`);

  // Create initial progress
  const initialProgress: PdfProgress = {
    phase: 'downloading',
    total_pages: undefined,
    pages_rendered: 0,
    pages_uploaded: 0,
  };

  // Create job in DynamoDB with PDF-specific fields
  const job: Omit<PdfJob, 'created_at' | 'updated_at' | 'ttl'> = {
    job_id: jobId,
    status: 'pending',
    phase: 'init',
    progress: initialProgress,
    retry_count: 0,
    entity_id: validatedInput.entity_id,
    api_base: validatedInput.api_base,
    api_key: validatedInput.api_key,
    network: validatedInput.network,
    collection: validatedInput.collection,
    target_file_key: validatedInput.target_file_key,
    options: validatedInput.options,
    // PDF-specific fields
    mode: pdfOptions.mode,
    quality: pdfOptions.quality,
    dpi: pdfOptions.dpi,
    max_dimension: pdfOptions.max_dimension,
    page_group_size: pdfOptions.page_group_size,
  };

  await createJob(job);

  // Invoke self asynchronously
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw new Error('AWS_LAMBDA_FUNCTION_NAME environment variable not set');
  }

  console.log(`[start] Invoking async processing for job ${jobId}`);

  await lambdaClient.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: InvocationType.Event, // Fire-and-forget
    Payload: JSON.stringify({ action: 'process', job_id: jobId }),
  }));

  console.log(`[start] Job ${jobId} created and processing started`);

  return { success: true, job_id: jobId, status: 'pending' };
}
