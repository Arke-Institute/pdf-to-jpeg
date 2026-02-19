/**
 * Lambda File Processor Template - Main Handler
 *
 * Endpoints:
 * - POST /start    - Create async job, returns job_id immediately
 * - GET /status/:id - Poll for job status and progress
 *
 * Async invocation:
 * - { action: 'process', job_id: string } - Process job (self-invoked)
 */

import type {
  LambdaHttpEvent,
  LambdaResponse,
  AsyncInvokePayload,
  ErrorResponse,
} from './lib/types.js';
import { handleStart } from './handlers/start.js';
import { handleStatus } from './handlers/status.js';
import { handleProcess } from './handlers/process.js';

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorResponse(statusCode: number, message: string): LambdaResponse {
  const body: ErrorResponse = { success: false, error: message };
  return jsonResponse(statusCode, body);
}

// =============================================================================
// Secret Validation
// =============================================================================

function validateSecret(event: LambdaHttpEvent): boolean {
  const secret = event.headers['x-lambda-secret'];
  const expectedSecret = process.env.LAMBDA_SECRET;

  if (!expectedSecret) {
    console.warn('[handler] LAMBDA_SECRET not set - accepting all requests');
    return true;
  }

  return secret === expectedSecret;
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Lambda handler for HTTP requests and async invocations
 */
export async function handler(
  event: LambdaHttpEvent | AsyncInvokePayload
): Promise<LambdaResponse | void> {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // =========================================================================
  // Async Invocation (self-invoke for processing)
  // =========================================================================
  if ('action' in event && event.action === 'process') {
    console.log(`[async] Processing job ${event.job_id}`);
    await handleProcess(event.job_id);
    return; // No HTTP response for async invoke
  }

  // =========================================================================
  // HTTP Request
  // =========================================================================
  const httpEvent = event as LambdaHttpEvent;
  const method = httpEvent.requestContext?.http?.method;
  const path = httpEvent.rawPath || httpEvent.requestContext?.http?.path;

  // Validate secret for all HTTP requests
  if (!validateSecret(httpEvent)) {
    return errorResponse(401, 'Unauthorized');
  }

  // -------------------------------------------------------------------------
  // POST /start - Create async job
  // -------------------------------------------------------------------------
  if (method === 'POST' && path === '/start') {
    try {
      const body = httpEvent.body
        ? httpEvent.isBase64Encoded
          ? JSON.parse(Buffer.from(httpEvent.body, 'base64').toString())
          : JSON.parse(httpEvent.body)
        : {};

      const result = await handleStart(body);
      return jsonResponse(200, result);
    } catch (error) {
      console.error('[/start] Error:', error);
      return errorResponse(500, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  // -------------------------------------------------------------------------
  // GET /status/:job_id - Poll status
  // -------------------------------------------------------------------------
  if (method === 'GET' && path?.startsWith('/status/')) {
    try {
      const jobId = path.replace('/status/', '');
      if (!jobId) {
        return errorResponse(400, 'job_id is required');
      }

      const result = await handleStatus(jobId);
      return jsonResponse(200, result);
    } catch (error) {
      console.error('[/status] Error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('not found') ? 404 : 500;
      return errorResponse(status, message);
    }
  }

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------
  if (method === 'GET' && (path === '/' || path === '/health')) {
    return jsonResponse(200, { status: 'ok', timestamp: new Date().toISOString() });
  }

  // -------------------------------------------------------------------------
  // Not Found
  // -------------------------------------------------------------------------
  return errorResponse(404, `Not found: ${method} ${path}`);
}
