/**
 * Lambda HTTP Client
 *
 * Communicates with the PDF-to-JPEG Lambda for processing.
 */

// =============================================================================
// Types
// =============================================================================

export interface LambdaStartInput {
  entity_id: string;
  api_base: string;
  api_key: string;
  network: 'test' | 'main';
  collection?: string;
  target_file_key?: string;
  options?: {
    mode?: 'auto' | 'render' | 'extract';
    quality?: number;
    dpi?: number;
    max_dimension?: number;
  };
}

export interface LambdaStartResponse {
  success: boolean;
  job_id: string;
  status: 'pending';
}

export interface LambdaProgress {
  phase: 'downloading' | 'rendering' | 'uploading' | 'linking' | 'complete';
  total_pages?: number;
  pages_rendered?: number;
  pages_uploaded?: number;
}

export interface LambdaPageResult {
  page_number: number;
  entity_id: string;
  width: number;
  height: number;
  size_bytes: number;
}

export interface LambdaResult {
  source_id: string;
  total_pages: number;
  pages: LambdaPageResult[];
  entity_ids: string[];
}

export interface LambdaError {
  code: string;
  message: string;
}

export interface LambdaStatusResponse {
  success: boolean;
  job_id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  phase: string;
  progress: LambdaProgress;
  result?: LambdaResult;
  error?: LambdaError;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

// =============================================================================
// Client
// =============================================================================

export class LambdaClient {
  constructor(
    private lambdaUrl: string,
    private lambdaSecret: string
  ) {
    // Ensure URL doesn't have trailing slash
    this.lambdaUrl = lambdaUrl.replace(/\/$/, '');
  }

  /**
   * Start a new PDF processing job
   */
  async startJob(input: LambdaStartInput): Promise<LambdaStartResponse> {
    const response = await fetch(`${this.lambdaUrl}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lambda-Secret': this.lambdaSecret,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Lambda start failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as LambdaStartResponse;

    if (!data.success) {
      throw new Error('Lambda start returned unsuccessful response');
    }

    return data;
  }

  /**
   * Get job status
   */
  async getStatus(jobId: string): Promise<LambdaStatusResponse> {
    const response = await fetch(`${this.lambdaUrl}/status/${jobId}`, {
      method: 'GET',
      headers: {
        'X-Lambda-Secret': this.lambdaSecret,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Lambda status failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as LambdaStatusResponse;

    if (!data.success) {
      throw new Error('Lambda status returned unsuccessful response');
    }

    return data;
  }
}
