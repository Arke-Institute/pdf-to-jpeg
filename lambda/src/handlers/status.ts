/**
 * Status Handler - Returns job status and progress
 *
 * GET /status/:job_id
 */

import type { StatusResponse, BaseProgress, BaseResult } from '../lib/types.js';
import { getJob } from '../lib/dynamo.js';

/**
 * Handle GET /status/:job_id request
 */
export async function handleStatus<
  TProgress extends BaseProgress = BaseProgress,
  TResult extends BaseResult = BaseResult,
>(jobId: string): Promise<StatusResponse<TProgress, TResult>> {
  console.log(`[status] Getting status for job ${jobId}`);

  const job = await getJob(jobId);

  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const response: StatusResponse<TProgress, TResult> = {
    success: true,
    job_id: job.job_id,
    status: job.status,
    phase: job.phase,
    progress: job.progress as TProgress,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };

  // Include result if done
  if (job.status === 'done' && job.result) {
    response.result = job.result as TResult;
  }

  // Include completed_at if set
  if (job.completed_at) {
    response.completed_at = job.completed_at;
  }

  // Include error if failed
  if (job.status === 'error' && job.error) {
    response.error = job.error;
  }

  return response;
}
