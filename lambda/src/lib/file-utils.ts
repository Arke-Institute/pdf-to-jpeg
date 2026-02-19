/**
 * File utilities for entity content handling
 *
 * Implements file-input-conventions.md patterns:
 * - Type-agnostic entity processing (any entity with compatible files)
 * - File detection by MIME type and extension
 * - Content resolution priority (explicit key > fallback property > auto-detect)
 */

import type { ArkeClient } from '@arke-institute/sdk';

// =============================================================================
// Types
// =============================================================================

/**
 * File metadata from entity's properties.content
 */
export interface FileInfo {
  key: string;
  content_type?: string;
  size?: number;
  cid?: string;
  uploaded_at?: string;
}

/**
 * Entity with content map
 */
export interface EntityWithContent {
  id: string;
  type: string;
  properties: {
    content?: Record<string, {
      cid?: string;
      content_type?: string;
      size?: number;
      uploaded_at?: string;
    }>;
    [key: string]: unknown;
  };
}

/**
 * File type filter configuration
 */
export interface FileTypeFilter {
  /** MIME type prefixes to match (e.g., ['application/pdf', 'image/']) */
  mimeTypes?: string[];
  /** File extensions to match (e.g., ['.pdf', '.jpg']) */
  extensions?: string[];
}

// =============================================================================
// File Listing
// =============================================================================

/**
 * Extract files from entity properties.content
 *
 * @example
 * ```typescript
 * const files = listEntityFiles(entity);
 * // [{ key: 'document.pdf', content_type: 'application/pdf', size: 12345 }]
 * ```
 */
export function listEntityFiles(entity: EntityWithContent): FileInfo[] {
  const content = entity.properties.content;

  if (!content || typeof content !== 'object') {
    return [];
  }

  return Object.entries(content).map(([key, meta]) => ({
    key,
    content_type: meta.content_type,
    size: meta.size,
    cid: meta.cid,
    uploaded_at: meta.uploaded_at,
  }));
}

// =============================================================================
// File Detection
// =============================================================================

/**
 * Check if a file matches the type filter
 */
export function fileMatchesFilter(file: FileInfo, filter: FileTypeFilter): boolean {
  const { mimeTypes = [], extensions = [] } = filter;

  // Check MIME type
  if (mimeTypes.length > 0 && file.content_type) {
    for (const mimeType of mimeTypes) {
      if (mimeType.endsWith('/')) {
        // Prefix match (e.g., 'image/' matches 'image/jpeg')
        if (file.content_type.startsWith(mimeType)) {
          return true;
        }
      } else {
        // Exact match
        if (file.content_type === mimeType) {
          return true;
        }
      }
    }
  }

  // Check extension
  if (extensions.length > 0) {
    const keyLower = file.key.toLowerCase();
    for (const ext of extensions) {
      if (keyLower.endsWith(ext.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Find first file matching the type filter
 */
export function findFileByType(
  files: FileInfo[],
  filter: FileTypeFilter
): FileInfo | undefined {
  return files.find(file => fileMatchesFilter(file, filter));
}

/**
 * Find all files matching the type filter
 */
export function findFilesByType(
  files: FileInfo[],
  filter: FileTypeFilter
): FileInfo[] {
  return files.filter(file => fileMatchesFilter(file, filter));
}

// =============================================================================
// Content Resolution
// =============================================================================

/**
 * Resolve which file to process following priority order:
 *
 * 1. Explicit file key (from input.target_file_key)
 * 2. Auto-detect from files by type filter
 *
 * @throws Error if no matching file found
 *
 * @example
 * ```typescript
 * // PDF processor looking for PDF files
 * const file = resolveTargetFile(entity, targetFileKey, {
 *   mimeTypes: ['application/pdf'],
 *   extensions: ['.pdf'],
 * });
 * ```
 */
export function resolveTargetFile(
  entity: EntityWithContent,
  targetFileKey?: string,
  acceptedTypes?: FileTypeFilter
): FileInfo {
  const files = listEntityFiles(entity);

  // 1. Explicit file key - highest priority
  if (targetFileKey) {
    const file = files.find(f => f.key === targetFileKey);

    if (!file) {
      throw new Error(
        `FILE_NOT_FOUND: File '${targetFileKey}' not found on entity ${entity.id}. ` +
        `Available files: ${files.map(f => f.key).join(', ') || 'none'}`
      );
    }

    // Validate type if filter provided
    if (acceptedTypes && !fileMatchesFilter(file, acceptedTypes)) {
      throw new Error(
        `UNSUPPORTED_TYPE: File '${targetFileKey}' has type '${file.content_type}' ` +
        `which is not supported by this processor`
      );
    }

    return file;
  }

  // 2. Auto-detect from files
  if (files.length === 0) {
    throw new Error(
      `NO_CONTENT: No files found on entity ${entity.id}. ` +
      `Entity type: ${entity.type}`
    );
  }

  if (acceptedTypes) {
    const matchingFile = findFileByType(files, acceptedTypes);

    if (!matchingFile) {
      throw new Error(
        `NO_CONTENT: No matching files found on entity ${entity.id}. ` +
        `Looking for: ${JSON.stringify(acceptedTypes)}. ` +
        `Available: ${files.map(f => `${f.key} (${f.content_type})`).join(', ')}`
      );
    }

    return matchingFile;
  }

  // No filter - return first file
  return files[0];
}

// =============================================================================
// File Download
// =============================================================================

/**
 * Download file content from entity
 *
 * Uses direct HTTP fetch since SDK doesn't properly support key parameter.
 *
 * @example
 * ```typescript
 * const file = resolveTargetFile(entity, targetFileKey, PDF_FILTER);
 * const content = await downloadEntityFile(client, entity.id, file.key);
 * ```
 */
export async function downloadEntityFile(
  client: ArkeClient,
  entityId: string,
  fileKey?: string
): Promise<Buffer> {
  // Build URL with key parameter
  const baseUrl = (client as unknown as { baseUrl: string }).baseUrl || 'https://arke-v1.arke.institute';
  const authToken = (client as unknown as { authToken: string }).authToken;
  const network = (client as unknown as { network: string }).network;

  let url = `${baseUrl}/entities/${entityId}/content`;
  if (fileKey) {
    url += `?key=${encodeURIComponent(fileKey)}`;
  }

  const headers: Record<string, string> = {
    'Authorization': `ApiKey ${authToken}`,
  };

  if (network) {
    headers['X-Arke-Network'] = network;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DOWNLOAD_FAILED: Failed to download from ${entityId}: ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// =============================================================================
// Size Validation
// =============================================================================

/**
 * Validate file size against limit
 *
 * @throws Error if file exceeds size limit
 */
export function validateFileSize(
  file: FileInfo,
  maxSizeBytes: number,
  processorName: string = 'processor'
): void {
  if (file.size && file.size > maxSizeBytes) {
    const sizeMB = Math.round(file.size / 1024 / 1024);
    const limitMB = Math.round(maxSizeBytes / 1024 / 1024);

    throw new Error(
      `FILE_TOO_LARGE: File '${file.key}' is ${sizeMB}MB which exceeds the ` +
      `${limitMB}MB limit for ${processorName}`
    );
  }
}

// =============================================================================
// Common File Type Filters
// =============================================================================

/** PDF files */
export const PDF_FILTER: FileTypeFilter = {
  mimeTypes: ['application/pdf'],
  extensions: ['.pdf'],
};

/** JPEG images */
export const JPEG_FILTER: FileTypeFilter = {
  mimeTypes: ['image/jpeg'],
  extensions: ['.jpg', '.jpeg'],
};

/** PNG images */
export const PNG_FILTER: FileTypeFilter = {
  mimeTypes: ['image/png'],
  extensions: ['.png'],
};

/** All common images */
export const IMAGE_FILTER: FileTypeFilter = {
  mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff'],
  extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.tif'],
};

/** Text files */
export const TEXT_FILTER: FileTypeFilter = {
  mimeTypes: ['text/'],
  extensions: ['.txt', '.md', '.text'],
};
