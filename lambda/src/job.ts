/**
 * PDF-to-JPEG Job Processor
 *
 * Converts PDF pages to JPEG images using Ghostscript and uploads
 * each page as a separate file entity linked to the source.
 */

import type {
  ProcessContext,
  ProcessResult,
  PdfJob,
  PdfResult,
  PageResult,
} from './lib/types.js';
import {
  createArkeClient,
  getEntity,
  createAndUploadFile,
  updateEntity,
  batchCreateFileEntities,
  parallelUploadContent,
} from './lib/arke.js';
import {
  resolveTargetFile,
  downloadEntityFile,
  validateFileSize,
  PDF_FILTER,
  type EntityWithContent,
} from './lib/file-utils.js';
import {
  savePdfToTemp,
  cleanupTempPdf,
  getPageCount,
  renderAllPages,
  renderAllPagesBatch,
  type RenderOptions,
} from './lib/pdf-render.js';

// =============================================================================
// Configuration
// =============================================================================

const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB

// =============================================================================
// Main Processing Function
// =============================================================================

/**
 * Process PDF to JPEG conversion
 */
export async function processJob(
  ctx: ProcessContext<PdfJob>
): Promise<ProcessResult<PdfResult>> {
  const { job } = ctx;

  console.log(`[job] Processing PDF entity ${job.entity_id}`);
  console.log(`[job] Options: quality=${job.quality}, dpi=${job.dpi}, max_dimension=${job.max_dimension}`);

  // -------------------------------------------------------------------------
  // Step 1: Create Arke client and get entity
  // -------------------------------------------------------------------------
  const client = createArkeClient(job);
  await ctx.updateProgress({ phase: 'downloading' });

  const entity = await getEntity(client, job.entity_id);
  console.log(`[job] Got entity: ${entity.id} (type: ${entity.type})`);

  // -------------------------------------------------------------------------
  // Step 2: Resolve PDF file and download
  // -------------------------------------------------------------------------
  const entityWithContent: EntityWithContent = {
    id: entity.id,
    type: entity.type,
    properties: entity.properties as EntityWithContent['properties'],
  };

  const pdfFile = resolveTargetFile(entityWithContent, job.target_file_key, PDF_FILTER);
  console.log(`[job] Resolved PDF file: ${pdfFile.key} (${pdfFile.content_type}, ${pdfFile.size} bytes)`);

  // Validate size
  validateFileSize(pdfFile, MAX_PDF_SIZE, 'pdf-to-jpeg');

  // Download PDF content
  const pdfBuffer = await downloadEntityFile(client, entity.id, pdfFile.key);
  console.log(`[job] Downloaded PDF: ${pdfBuffer.length} bytes`);

  // -------------------------------------------------------------------------
  // Step 3: Save PDF to temp and get page count
  // -------------------------------------------------------------------------
  await ctx.updateProgress({ phase: 'rendering' });

  const pdfPath = savePdfToTemp(pdfBuffer);
  console.log(`[job] Saved PDF to temp: ${pdfPath}`);

  let totalPages: number;
  try {
    totalPages = await getPageCount(pdfPath);
    console.log(`[job] PDF has ${totalPages} pages`);
  } catch (error) {
    cleanupTempPdf(pdfPath);
    throw error;
  }

  await ctx.updateProgress({
    phase: 'rendering',
    total_pages: totalPages,
    pages_rendered: 0,
  });

  // -------------------------------------------------------------------------
  // Step 4: Render all pages to JPEG (OPTIMIZED - batch Ghostscript)
  // -------------------------------------------------------------------------
  const renderOptions: RenderOptions = {
    quality: job.quality,
    dpi: job.dpi,
    maxDimension: job.max_dimension,
  };

  let renderedPages;
  try {
    // Use batch rendering - single GS invocation for all pages
    renderedPages = await renderAllPagesBatch(pdfPath, totalPages, renderOptions, async (rendered, total) => {
      await ctx.updateProgress({
        phase: 'rendering',
        total_pages: total,
        pages_rendered: rendered,
      });
    });
  } finally {
    cleanupTempPdf(pdfPath);
  }

  console.log(`[job] Rendered ${renderedPages.length} pages (batch mode)`);

  // -------------------------------------------------------------------------
  // Step 5a: Batch create file entities (OPTIMIZED)
  // -------------------------------------------------------------------------
  await ctx.updateProgress({
    phase: 'uploading',
    total_pages: totalPages,
    pages_rendered: totalPages,
    pages_uploaded: 0,
  });

  // Prepare entity inputs for batch creation
  const entityInputs = renderedPages.map(page => ({
    filename: `page-${page.pageNumber.toString().padStart(4, '0')}.jpg`,
    contentType: 'image/jpeg',
    collection: job.collection,
    properties: {
      page_number: page.pageNumber,
      source_entity_id: job.entity_id,
      width: page.width,
      height: page.height,
    },
    relationships: [
      {
        predicate: 'derived_from',
        peer: job.entity_id,
      },
    ],
  }));

  // Batch create all entities (up to 100 per request)
  const createdEntities = await batchCreateFileEntities(client, entityInputs);
  const createdEntityIds = createdEntities.map(e => e.id);

  console.log(`[job] Batch created ${createdEntities.length} entities`);

  // Track created entities for idempotency
  await ctx.trackCreatedEntities(createdEntityIds);

  // -------------------------------------------------------------------------
  // Step 5b: Parallel upload content (OPTIMIZED)
  // -------------------------------------------------------------------------
  const uploads = renderedPages.map((page, i) => ({
    entityId: createdEntities[i].id,
    content: page.buffer,
    contentType: 'image/jpeg',
  }));

  await parallelUploadContent(client, uploads, 10);

  console.log(`[job] Uploaded all ${uploads.length} content files (parallel)`);

  // Build page results for response
  const pageResults: PageResult[] = renderedPages.map((page, i) => ({
    page_number: page.pageNumber,
    entity_id: createdEntities[i].id,
    width: page.width,
    height: page.height,
    size_bytes: page.buffer.length,
  }));

  await ctx.updateProgress({
    phase: 'uploading',
    total_pages: totalPages,
    pages_rendered: totalPages,
    pages_uploaded: totalPages,
  });

  // -------------------------------------------------------------------------
  // Step 6: Link source entity to pages (has_page relationships)
  // -------------------------------------------------------------------------
  await ctx.updateProgress({ phase: 'linking' });

  // Add has_page relationships from source to all pages
  await updateEntity(client, job.entity_id, {
    relationships_add: pageResults.map((page) => ({
      predicate: 'has_page',
      peer: page.entity_id,
    })),
  });

  console.log(`[job] Linked source entity to ${pageResults.length} pages`);

  // -------------------------------------------------------------------------
  // Step 7: Return results
  // -------------------------------------------------------------------------
  await ctx.updateProgress({ phase: 'complete' });

  const result: PdfResult = {
    source_id: job.entity_id,
    total_pages: totalPages,
    pages: pageResults,
    entity_ids: createdEntityIds,
  };

  console.log(`[job] Processing complete: ${totalPages} pages converted`);

  return {
    entity_ids: createdEntityIds,
    result,
  };
}
