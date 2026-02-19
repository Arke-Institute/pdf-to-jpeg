/**
 * DynamoDB helpers for async job tracking
 *
 * Provides CRUD operations for job records with progress tracking.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BaseJob, JobStatus, ProcessContext, BaseProgress, BaseResult } from './types.js';

// =============================================================================
// Configuration
// =============================================================================

const TABLE_NAME = process.env.DYNAMODB_TABLE || 'arke-processor-jobs';
const REGION = process.env.AWS_REGION || 'us-east-1';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// =============================================================================
// Client
// =============================================================================

const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate a unique job ID
 */
export function generateJobId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `job_${timestamp}${random}`;
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Get a job by ID
 */
export async function getJob<TJob extends BaseJob>(jobId: string): Promise<TJob | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { job_id: jobId },
    })
  );

  return (result.Item as TJob) || null;
}

/**
 * Create a new job record
 */
export async function createJob<TJob extends BaseJob>(
  job: Omit<TJob, 'created_at' | 'updated_at' | 'ttl'>
): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...job,
        created_at: now,
        updated_at: now,
        ttl,
      },
    })
  );

  console.log(`[dynamo] Created job ${job.job_id}`);
}

/**
 * Update job status and phase
 */
export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  phase: string
): Promise<void> {
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { job_id: jobId },
      UpdateExpression: 'SET #status = :status, #phase = :phase, updated_at = :now',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#phase': 'phase',
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':phase': phase,
        ':now': now,
      },
    })
  );

  console.log(`[dynamo] Updated job ${jobId}: status=${status}, phase=${phase}`);
}

/**
 * Update job progress fields
 */
export async function updateJobProgress(
  jobId: string,
  progress: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();

  const updates: string[] = ['updated_at = :now'];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = { ':now': now };

  let fieldIndex = 0;
  for (const [key, value] of Object.entries(progress)) {
    if (value !== undefined) {
      const attrName = `#progress`;
      const fieldName = `#field${fieldIndex}`;
      const attrValue = `:val${fieldIndex}`;

      updates.push(`${attrName}.${fieldName} = ${attrValue}`);
      expressionAttributeNames[attrName] = 'progress';
      expressionAttributeNames[fieldName] = key;
      expressionAttributeValues[attrValue] = value;
      fieldIndex++;
    }
  }

  if (fieldIndex === 0) return; // No progress fields to update

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { job_id: jobId },
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
}

/**
 * Append items to a list field (for idempotency tracking)
 */
export async function appendToList(
  jobId: string,
  field: string,
  items: unknown[]
): Promise<void> {
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { job_id: jobId },
      UpdateExpression:
        'SET #field = list_append(if_not_exists(#field, :emptyList), :items), updated_at = :now',
      ExpressionAttributeNames: {
        '#field': field,
      },
      ExpressionAttributeValues: {
        ':items': items,
        ':emptyList': [],
        ':now': now,
      },
    })
  );

  console.log(`[dynamo] Appended ${items.length} items to ${field} on job ${jobId}`);
}

/**
 * Mark job as complete
 */
export async function completeJob(jobId: string, result?: unknown): Promise<void> {
  const now = new Date().toISOString();

  const updateExpression = result !== undefined
    ? 'SET #status = :status, #phase = :phase, #result = :result, completed_at = :now, updated_at = :now'
    : 'SET #status = :status, #phase = :phase, completed_at = :now, updated_at = :now';

  const expressionAttributeNames: Record<string, string> = {
    '#status': 'status',
    '#phase': 'phase',
  };

  const expressionAttributeValues: Record<string, unknown> = {
    ':status': 'done',
    ':phase': 'complete',
    ':now': now,
  };

  if (result !== undefined) {
    expressionAttributeNames['#result'] = 'result';
    expressionAttributeValues[':result'] = result;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { job_id: jobId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  console.log(`[dynamo] Completed job ${jobId}`);
}

/**
 * Mark job as failed
 */
export async function failJob(jobId: string, code: string, message: string): Promise<void> {
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { job_id: jobId },
      UpdateExpression:
        'SET #status = :status, #error = :error, completed_at = :now, updated_at = :now, ' +
        'retry_count = if_not_exists(retry_count, :zero) + :one',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#error': 'error',
      },
      ExpressionAttributeValues: {
        ':status': 'error',
        ':error': { code, message },
        ':now': now,
        ':zero': 0,
        ':one': 1,
      },
    })
  );

  console.log(`[dynamo] Failed job ${jobId}: ${code} - ${message}`);
}

// =============================================================================
// Process Context Factory
// =============================================================================

/**
 * Create ProcessContext for use in processJob
 *
 * Provides convenient methods for updating job state during processing.
 */
export function createProcessContext<
  TJob extends BaseJob<TProgress, TResult>,
  TProgress extends BaseProgress = BaseProgress,
  TResult extends BaseResult = BaseResult,
>(job: TJob): ProcessContext<TJob> {
  const jobId = job.job_id;

  return {
    job,

    async updateProgress(progress: Partial<TProgress>): Promise<void> {
      await updateJobProgress(jobId, progress as Record<string, unknown>);
    },

    async updateStatus(status: JobStatus, phase: string): Promise<void> {
      await updateJobStatus(jobId, status, phase);
    },

    async complete(result?: TResult): Promise<void> {
      await completeJob(jobId, result);
    },

    async fail(code: string, message: string): Promise<void> {
      await failJob(jobId, code, message);
    },

    async trackCreatedEntities(entityIds: string[]): Promise<void> {
      await appendToList(jobId, 'created_entity_ids', entityIds);
    },

    async refreshJob(): Promise<TJob | null> {
      return getJob<TJob>(jobId);
    },
  };
}
