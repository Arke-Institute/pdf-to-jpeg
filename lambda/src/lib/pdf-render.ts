/**
 * PDF Rendering with Ghostscript
 *
 * Renders PDF pages to JPEG images using Ghostscript from Lambda layer.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

// Ghostscript binary path from Lambda layer
const GS_PATH = '/opt/bin/gs';

// Temp directory for rendering
const TMP_DIR = '/tmp/pdf-render';

// =============================================================================
// Types
// =============================================================================

export interface RenderOptions {
  quality: number;      // JPEG quality 1-100
  dpi: number;          // Render resolution
  maxDimension: number; // Max width/height before resize
}

export interface RenderedPage {
  pageNumber: number;
  buffer: Buffer;
  width: number;
  height: number;
}

// =============================================================================
// Page Count
// =============================================================================

/**
 * Get page count from PDF using Ghostscript
 */
export async function getPageCount(pdfPath: string): Promise<number> {
  const cmd = `${GS_PATH} -q -dNODISPLAY -c "(${pdfPath}) (r) file runpdfbegin pdfpagecount = quit"`;

  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
    const count = parseInt(stdout.trim(), 10);
    if (isNaN(count) || count < 1) {
      throw new Error(`Invalid page count: ${stdout}`);
    }
    return count;
  } catch (error) {
    // Fallback: try rendering first page to verify it's a valid PDF
    console.warn('[getPageCount] Primary method failed, trying fallback...');
    try {
      await renderSinglePage(pdfPath, 1, { quality: 50, dpi: 72, maxDimension: 100 });
      // If we got here, PDF is valid but we don't know page count
      // This shouldn't happen with valid PDFs
      throw new Error('Could not determine page count');
    } catch {
      throw new Error('Invalid or corrupted PDF file');
    }
  }
}

// =============================================================================
// Single Page Rendering
// =============================================================================

/**
 * Render a single page to JPEG
 */
async function renderSinglePage(
  pdfPath: string,
  pageNumber: number,
  options: RenderOptions
): Promise<RenderedPage> {
  ensureTmpDir();
  const timestamp = Date.now();
  const outputPath = join(TMP_DIR, `page-${timestamp}-${pageNumber}.jpg`);

  const gsCommand = [
    GS_PATH,
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=jpeg',
    `-dJPEGQ=${options.quality}`,
    `-r${options.dpi}`,
    `-dFirstPage=${pageNumber}`,
    `-dLastPage=${pageNumber}`,
    `-sOutputFile=${outputPath}`,
    pdfPath,
  ].join(' ');

  try {
    await execAsync(gsCommand, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`Ghostscript failed for page ${pageNumber}: ${err.stderr || err.message}`);
  }

  if (!existsSync(outputPath)) {
    throw new Error(`Ghostscript did not produce output for page ${pageNumber}`);
  }

  // Read and optionally resize
  const result = await processRenderedFile(outputPath, pageNumber, options);

  // Clean up
  try {
    unlinkSync(outputPath);
  } catch { /* ignore */ }

  return result;
}

// =============================================================================
// Batch Rendering
// =============================================================================

/**
 * Render all pages to JPEG
 *
 * Uses parallel Ghostscript processes for speed.
 */
export async function renderAllPages(
  pdfPath: string,
  totalPages: number,
  options: RenderOptions,
  onProgress?: (rendered: number, total: number) => void
): Promise<RenderedPage[]> {
  ensureTmpDir();
  // Note: Don't clean tmp dir here - the input PDF is stored there!

  const results: RenderedPage[] = [];
  const timestamp = Date.now();

  // Verify Ghostscript exists
  if (!existsSync(GS_PATH)) {
    throw new Error(`Ghostscript not found at ${GS_PATH}. Lambda layer may be missing.`);
  }

  // For simplicity, render pages sequentially in this implementation
  // (The original pdf-processor uses parallel workers, but that adds complexity)
  console.log(`[renderAllPages] Rendering ${totalPages} pages at ${options.dpi} DPI (gs: ${GS_PATH})`);

  for (let page = 1; page <= totalPages; page++) {
    const outputPath = join(TMP_DIR, `page-${timestamp}-${page}.jpg`);

    const gsCommand = [
      GS_PATH,
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=jpeg',
      `-dJPEGQ=${options.quality}`,
      `-r${options.dpi}`,
      `-dFirstPage=${page}`,
      `-dLastPage=${page}`,
      `-sOutputFile=${outputPath}`,
      pdfPath,
    ].join(' ');

    try {
      console.log(`[renderAllPages] Running: ${gsCommand}`);
      const { stdout, stderr } = await execAsync(gsCommand, { maxBuffer: 10 * 1024 * 1024 });
      if (stderr) {
        console.log(`[renderAllPages] GS stderr: ${stderr}`);
      }
      if (stdout) {
        console.log(`[renderAllPages] GS stdout: ${stdout}`);
      }
    } catch (error) {
      const err = error as { stderr?: string; stdout?: string; message?: string };
      console.error(`[renderAllPages] GS error:`, { stderr: err.stderr, stdout: err.stdout, message: err.message });
      throw new Error(`Ghostscript failed for page ${page}: ${err.stderr || err.stdout || err.message}`);
    }

    if (!existsSync(outputPath)) {
      throw new Error(`Ghostscript did not produce output for page ${page}`);
    }

    const result = await processRenderedFile(outputPath, page, options);
    results.push(result);

    // Clean up file immediately
    try {
      unlinkSync(outputPath);
    } catch { /* ignore */ }

    // Report progress
    if (onProgress) {
      onProgress(page, totalPages);
    }

    if (page % 10 === 0) {
      console.log(`[renderAllPages] Rendered ${page}/${totalPages} pages`);
    }
  }

  console.log(`[renderAllPages] Completed rendering ${totalPages} pages`);
  return results;
}

// =============================================================================
// Post-Processing
// =============================================================================

/**
 * Parse JPEG dimensions from buffer (no external dependencies)
 * Reads SOF0/SOF2 marker to extract width and height
 */
function getJpegDimensions(buffer: Buffer): { width: number; height: number } {
  let offset = 0;

  // Check JPEG magic bytes
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Not a valid JPEG file');
  }
  offset = 2;

  while (offset < buffer.length) {
    // Find next marker
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];

    // SOF0 (Baseline) or SOF2 (Progressive)
    if (marker === 0xc0 || marker === 0xc2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }

    // Skip this segment
    if (marker >= 0xc0 && marker <= 0xfe && marker !== 0xd8 && marker !== 0xd9) {
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    } else {
      offset += 2;
    }
  }

  throw new Error('Could not find JPEG dimensions');
}

/**
 * Process a rendered JPEG file
 * Note: Resizing removed - control output size via DPI setting
 */
async function processRenderedFile(
  filePath: string,
  pageNumber: number,
  _options: RenderOptions
): Promise<RenderedPage> {
  const buffer: Buffer = readFileSync(filePath);
  const { width, height } = getJpegDimensions(buffer);

  return {
    pageNumber,
    buffer,
    width,
    height,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function ensureTmpDir(): void {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

function cleanTmpDir(): void {
  try {
    if (existsSync(TMP_DIR)) {
      const files = readdirSync(TMP_DIR);
      for (const file of files) {
        try {
          unlinkSync(join(TMP_DIR, file));
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Save PDF buffer to temp file for Ghostscript
 */
export function savePdfToTemp(buffer: Buffer): string {
  ensureTmpDir();
  const pdfPath = join(TMP_DIR, `input-${Date.now()}.pdf`);
  writeFileSync(pdfPath, buffer);
  return pdfPath;
}

/**
 * Clean up temp PDF file
 */
export function cleanupTempPdf(pdfPath: string): void {
  try {
    if (existsSync(pdfPath)) {
      unlinkSync(pdfPath);
    }
  } catch { /* ignore */ }
}

// =============================================================================
// Optimized Batch Rendering
// =============================================================================

/**
 * Render all pages in a single Ghostscript invocation
 *
 * Uses %d output pattern to render all pages at once, which is much faster
 * than spawning N separate processes.
 */
export async function renderAllPagesBatch(
  pdfPath: string,
  totalPages: number,
  options: RenderOptions,
  onProgress?: (rendered: number, total: number) => void
): Promise<RenderedPage[]> {
  ensureTmpDir();

  // Verify Ghostscript exists
  if (!existsSync(GS_PATH)) {
    throw new Error(`Ghostscript not found at ${GS_PATH}. Lambda layer may be missing.`);
  }

  const timestamp = Date.now();
  // Use %04d pattern for page numbering (0001, 0002, etc.)
  const outputPattern = join(TMP_DIR, `page-${timestamp}-%04d.jpg`);

  console.log(`[renderAllPagesBatch] Rendering ${totalPages} pages at ${options.dpi} DPI (batch mode)`);

  // Single GS call for all pages
  const gsCommand = [
    GS_PATH,
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=jpeg',
    `-dJPEGQ=${options.quality}`,
    `-r${options.dpi}`,
    `-sOutputFile=${outputPattern}`,
    pdfPath,
  ].join(' ');

  console.log(`[renderAllPagesBatch] Running: ${gsCommand}`);

  try {
    const { stdout, stderr } = await execAsync(gsCommand, { maxBuffer: 50 * 1024 * 1024 });
    if (stderr) {
      console.log(`[renderAllPagesBatch] GS stderr: ${stderr}`);
    }
    if (stdout) {
      console.log(`[renderAllPagesBatch] GS stdout: ${stdout}`);
    }
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    console.error(`[renderAllPagesBatch] GS error:`, { stderr: err.stderr, stdout: err.stdout, message: err.message });
    throw new Error(`Ghostscript batch render failed: ${err.stderr || err.stdout || err.message}`);
  }

  // Collect results - GS uses 1-indexed page numbers with %04d
  const results: RenderedPage[] = [];
  for (let page = 1; page <= totalPages; page++) {
    const outputPath = join(TMP_DIR, `page-${timestamp}-${page.toString().padStart(4, '0')}.jpg`);

    if (!existsSync(outputPath)) {
      throw new Error(`Ghostscript did not produce output for page ${page} at ${outputPath}`);
    }

    const result = await processRenderedFile(outputPath, page, options);
    results.push(result);

    // Clean up file immediately to free memory
    try {
      unlinkSync(outputPath);
    } catch { /* ignore */ }

    // Report progress
    if (onProgress) {
      onProgress(page, totalPages);
    }

    if (page % 10 === 0) {
      console.log(`[renderAllPagesBatch] Collected ${page}/${totalPages} pages`);
    }
  }

  console.log(`[renderAllPagesBatch] Completed batch rendering ${totalPages} pages`);
  return results;
}
