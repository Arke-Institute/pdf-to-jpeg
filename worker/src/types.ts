/**
 * Type definitions for the PDF-to-JPEG worker
 */

/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /** Klados agent ID (registered in Arke) - default/fallback */
  AGENT_ID: string;

  /** Agent version for logging */
  AGENT_VERSION: string;

  /** Arke agent API key (secret) - default/fallback */
  ARKE_AGENT_KEY: string;

  /** Network-specific agent ID for test network */
  AGENT_ID_TEST?: string;

  /** Network-specific agent ID for main network */
  AGENT_ID_MAIN?: string;

  /** Network-specific API key for test network (secret) */
  ARKE_AGENT_KEY_TEST?: string;

  /** Network-specific API key for main network (secret) */
  ARKE_AGENT_KEY_MAIN?: string;

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

  /** Index signature for NetworkEnv compatibility */
  [key: string]: unknown;
}

/**
 * Processing mode for PDF handling
 *
 * - 'auto': Detect whether PDF is scanned or digital (default)
 * - 'render': Force render pages as images (for scanned/image-based PDFs)
 * - 'extract': Force text extraction (for native/digital PDFs)
 *
 * Note: "render" mode outputs JPEGs that go through OCR.
 * "extract" mode outputs text directly, skipping OCR.
 */
export type ProcessingMode = 'auto' | 'render' | 'extract';

/**
 * PDF processing options passed via target_properties
 */
export interface PdfOptions {
  /** Processing mode - 'auto' detects PDF type */
  mode?: ProcessingMode;

  /** JPEG quality 1-100 (default: 85) */
  quality?: number;

  /** Render DPI (default: 300) */
  dpi?: number;

  /** Max width/height before resize (default: 2400) */
  max_dimension?: number;

  /** Number of pages per group for KG extraction context (default: 3, 0 or 1 = no grouping) */
  page_group_size?: number;
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
