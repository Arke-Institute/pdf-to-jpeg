/**
 * Type definitions for the PDF-to-JPEG worker
 */

/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /** Klados agent ID (registered in Arke) */
  AGENT_ID: string;

  /** Agent version for logging */
  AGENT_VERSION: string;

  /** Arke agent API key (secret) */
  ARKE_AGENT_KEY: string;

  /** Lambda function URL */
  LAMBDA_URL: string;

  /** Lambda authentication secret */
  LAMBDA_SECRET: string;

  /** Verification token for endpoint verification (set during registration) */
  VERIFICATION_TOKEN?: string;

  /** Agent ID for verification (used before AGENT_ID is configured) */
  ARKE_VERIFY_AGENT_ID?: string;

  /** Durable Object binding for job processing */
  KLADOS_JOB: DurableObjectNamespace;
}

/**
 * PDF processing options passed via target_properties
 */
export interface PdfOptions {
  /** JPEG quality 1-100 (default: 85) */
  quality?: number;

  /** Render DPI (default: 300) */
  dpi?: number;

  /** Max width/height before resize (default: 2400) */
  max_dimension?: number;
}

/**
 * Properties of the target entity being processed
 */
export interface TargetProperties {
  /** Specific file key to process (per file-input-conventions.md) */
  target_file_key?: string;

  /** PDF processing options */
  options?: PdfOptions;

  /** Allow any additional properties */
  [key: string]: unknown;
}

/**
 * Properties for output entities (JPEG pages)
 * Note: Output entities are created by Lambda, not this worker
 */
export interface OutputProperties {
  /** Page number (1-indexed) */
  page_number: number;

  /** Source PDF entity ID */
  source_entity_id: string;

  /** Image width in pixels */
  width: number;

  /** Image height in pixels */
  height: number;

  /** Allow any additional properties */
  [key: string]: unknown;
}
