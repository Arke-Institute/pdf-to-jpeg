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
import { createArkeClient, getEntity, createAndUploadFile, updateEntity } from './lib/arke.js';
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
  // Step 4: Render all pages to JPEG
  // -------------------------------------------------------------------------
  const renderOptions: RenderOptions = {
    quality: job.quality,
    dpi: job.dpi,
    maxDimension: job.max_dimension,
  };

  let renderedPages;
  try {
    renderedPages = await renderAllPages(pdfPath, totalPages, renderOptions, async (rendered, total) => {
      await ctx.updateProgress({
        phase: 'rendering',
        total_pages: total,
        pages_rendered: rendered,
      });
    });
  } finally {
    cleanupTempPdf(pdfPath);
  }

  console.log(`[job] Rendered ${renderedPages.length} pages`);

  // -------------------------------------------------------------------------
  // Step 5: Upload JPEG pages as file entities
  // -------------------------------------------------------------------------
  await ctx.updateProgress({
    phase: 'uploading',
    total_pages: totalPages,
    pages_rendered: totalPages,
    pages_uploaded: 0,
  });

  const pageResults: PageResult[] = [];
  const createdEntityIds: string[] = [];

  for (const page of renderedPages) {
    const filename = `page-${page.pageNumber.toString().padStart(4, '0')}.jpg`;

    // Create file entity with relationship to source
    const { id: fileId } = await createAndUploadFile(client, {
      filename,
      content: page.buffer,
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
    });

    pageResults.push({
      page_number: page.pageNumber,
      entity_id: fileId,
      width: page.width,
      height: page.height,
      size_bytes: page.buffer.length,
    });

    createdEntityIds.push(fileId);

    // Track created entities for idempotency
    await ctx.trackCreatedEntities([fileId]);

    // Update progress
    await ctx.updateProgress({
      phase: 'uploading',
      total_pages: totalPages,
      pages_rendered: totalPages,
      pages_uploaded: pageResults.length,
    });

    if (pageResults.length % 10 === 0) {
      console.log(`[job] Uploaded ${pageResults.length}/${totalPages} pages`);
    }
  }

  console.log(`[job] Uploaded all ${pageResults.length} pages`);

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
