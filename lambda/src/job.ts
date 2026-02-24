/**
 * PDF Processor Job Handler
 *
 * Handles PDF processing with automatic type detection:
 * - 'auto' mode: Detects PDF type (scanned vs digital) and routes accordingly
 * - 'render' mode: Force render pages to JPEG (for OCR pipeline)
 * - 'extract' mode: Force text extraction (skip OCR, direct to KG)
 *
 * Scanned/rendered PDFs produce JPEG pages that need OCR.
 * Digital/extracted PDFs produce text that goes directly to KG extraction.
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
  renderAllPagesBatch,
  type RenderOptions,
} from './lib/pdf-render.js';
import { detectPdfTypeFromBuffer } from './lib/pdf-analysis.js';
import { extractTextFromBuffer } from './lib/pdf-extract.js';
import { extractImagesFromBuffer, transformTextWithImageRefs } from './lib/pdf-images.js';

// =============================================================================
// Configuration
// =============================================================================

const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB

// =============================================================================
// Main Processing Function
// =============================================================================

/**
 * Process PDF based on mode (auto-detect, render, or extract)
 */
export async function processJob(
  ctx: ProcessContext<PdfJob>
): Promise<ProcessResult<PdfResult>> {
  const { job } = ctx;

  console.log(`[job] Processing PDF entity ${job.entity_id}`);
  console.log(`[job] Mode: ${job.mode}, quality=${job.quality}, dpi=${job.dpi}, max_dimension=${job.max_dimension}`);

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
  // Step 3: Determine processing mode (always detect, may override forced mode)
  // -------------------------------------------------------------------------
  await ctx.updateProgress({ phase: 'detecting' });

  const detection = await detectPdfTypeFromBuffer(pdfBuffer, 'auto');
  console.log(`[job] Detection result: ${detection.pdfType} (confidence: ${detection.confidence}, method: ${detection.method})`);

  // Update job with detection results
  await ctx.updateProgress({
    phase: 'detecting',
    detected_type: detection.pdfType,
  });

  let processingMode: 'render' | 'extract';

  if (job.mode === 'auto') {
    // Route based on detection: digital → extract, scanned → render
    processingMode = detection.pdfType === 'digital' ? 'extract' : 'render';
    console.log(`[job] Auto-detected: ${detection.pdfType} → ${processingMode} mode`);
  } else if (job.mode === 'extract' && detection.pdfType === 'scanned') {
    // Forced extract on scanned PDF - fall back to render to avoid timeout
    console.log(`[job] WARNING: Forced extract mode on scanned PDF, falling back to render mode`);
    processingMode = 'render';
  } else {
    processingMode = job.mode === 'extract' ? 'extract' : 'render';
    console.log(`[job] Using forced mode: ${job.mode}`);
  }

  // -------------------------------------------------------------------------
  // Step 4: Branch based on processing mode
  // -------------------------------------------------------------------------
  if (processingMode === 'extract') {
    return processExtractMode(ctx, pdfBuffer, job, client);
  }

  // Continue with render mode (existing logic)
  return processRenderMode(ctx, pdfBuffer, job, client);
}

/**
 * Process PDF in extract mode - extract native text and embedded images
 *
 * For digital PDFs:
 * 1. Extract text from each page (no OCR needed)
 * 2. Extract embedded images as separate entities (need OCR)
 * 3. Transform text to include arke: URI references to extracted images
 *
 * NOTE: If this is called on a scanned PDF, image extraction will be slow
 * and may timeout. Consider using auto mode which detects PDF type.
 */
async function processExtractMode(
  ctx: ProcessContext<PdfJob>,
  pdfBuffer: Buffer,
  job: PdfJob,
  client: ReturnType<typeof createArkeClient>,
): Promise<ProcessResult<PdfResult>> {
  // -------------------------------------------------------------------------
  // Step 1: Extract text from all pages
  // -------------------------------------------------------------------------
  await ctx.updateProgress({ phase: 'extracting' });

  const textExtraction = await extractTextFromBuffer(pdfBuffer, async (extracted, total) => {
    await ctx.updateProgress({
      phase: 'extracting',
      total_pages: total,
      pages_rendered: extracted,
    });
  });

  console.log(`[job] Extracted text from ${textExtraction.totalPages} pages (${textExtraction.totalChars} total chars)`);

  // -------------------------------------------------------------------------
  // Step 2: Extract embedded images from all pages
  // -------------------------------------------------------------------------
  const imageExtraction = await extractImagesFromBuffer(pdfBuffer, job.quality);

  console.log(`[job] Extracted ${imageExtraction.totalImages} images from PDF`);

  // -------------------------------------------------------------------------
  // Step 3: Create image entities (if any images found)
  // -------------------------------------------------------------------------
  const imageEntityIds = new Map<string, string>(); // "pageNum-imageIndex" -> entityId
  const allImageResults: PageResult[] = [];

  if (imageExtraction.totalImages > 0) {
    // Prepare image entity inputs
    const imageEntityInputs = imageExtraction.images.map((img) => ({
      filename: `extracted-p${img.pageNumber}-img${img.imageIndex}.jpg`,
      contentType: 'image/jpeg',
      collection: job.collection,
      properties: {
        page_number: img.pageNumber,
        image_index: img.imageIndex,
        source_entity_id: job.entity_id,
        width: img.width,
        height: img.height,
        extraction_source: 'pdf',
        source_image_ref: img.imageName,
      },
      relationships: [
        {
          predicate: 'extracted_from',
          peer: job.entity_id,
        },
      ],
    }));

    // Batch create image entities
    const createdImageEntities = await batchCreateFileEntities(client, imageEntityInputs);
    console.log(`[job] Batch created ${createdImageEntities.length} image entities`);

    // Track created entities for idempotency
    await ctx.trackCreatedEntities(createdImageEntities.map(e => e.id));

    // Build image key to entity ID map
    imageExtraction.images.forEach((img, i) => {
      const key = `${img.pageNumber}-${img.imageIndex}`;
      imageEntityIds.set(key, createdImageEntities[i].id);
    });

    // Upload image content
    const imageUploads = imageExtraction.images.map((img, i) => ({
      entityId: createdImageEntities[i].id,
      content: img.buffer,
      contentType: 'image/jpeg',
    }));

    await parallelUploadContent(client, imageUploads, 10);
    console.log(`[job] Uploaded ${imageUploads.length} image files`);

    // Build image results (need OCR)
    imageExtraction.images.forEach((img, i) => {
      allImageResults.push({
        page_number: img.pageNumber,
        entity_id: createdImageEntities[i].id,
        width: img.width,
        height: img.height,
        size_bytes: img.size,
        needs_ocr: true,    // Extracted images need OCR
        page_type: 'image', // Image type
      });
    });
  }

  // -------------------------------------------------------------------------
  // Step 4: Transform text with arke: URI references
  // -------------------------------------------------------------------------
  const pageTexts = new Map<number, string>();
  textExtraction.pages.forEach((page) => {
    pageTexts.set(page.pageNumber, page.text);
  });

  const transformedTexts = transformTextWithImageRefs(
    pageTexts,
    imageExtraction.pageImageMap,
    imageEntityIds
  );

  // -------------------------------------------------------------------------
  // Step 5: Create text entities for each page
  // -------------------------------------------------------------------------
  await ctx.updateProgress({
    phase: 'uploading',
    total_pages: textExtraction.totalPages,
    pages_rendered: textExtraction.totalPages,
    pages_uploaded: 0,
  });

  // Prepare text entity inputs with text in property (not file content)
  const textEntityInputs = textExtraction.pages.map((page) => {
    const pageImages = imageExtraction.pageImageMap.get(page.pageNumber) || [];
    const hasImages = pageImages.length > 0;
    const transformedText = transformedTexts.get(page.pageNumber) || page.text;

    return {
      filename: `page-${page.pageNumber.toString().padStart(4, '0')}.txt`,
      contentType: 'text/plain',
      collection: job.collection,
      properties: {
        page_number: page.pageNumber,
        source_entity_id: job.entity_id,
        char_count: page.charCount,
        text_source: 'pdf_extraction',
        has_extracted_images: hasImages,
        extracted_image_count: pageImages.length,
        // Store text directly in property, not as file content
        text: transformedText,
      },
      relationships: [
        {
          predicate: 'derived_from',
          peer: job.entity_id,
        },
      ],
    };
  });

  // Batch create text entities (text is in properties, no content upload needed)
  const createdTextEntities = await batchCreateFileEntities(client, textEntityInputs);
  const createdTextEntityIds = createdTextEntities.map(e => e.id);

  console.log(`[job] Batch created ${createdTextEntities.length} text entities with text property`);

  // Track created entities for idempotency
  await ctx.trackCreatedEntities(createdTextEntityIds);

  // Build text page results (no OCR needed)
  const textPageResults: PageResult[] = textExtraction.pages.map((page, i) => {
    const transformedText = transformedTexts.get(page.pageNumber) || page.text;
    return {
      page_number: page.pageNumber,
      entity_id: createdTextEntities[i].id,
      width: 0,
      height: 0,
      size_bytes: Buffer.byteLength(transformedText, 'utf-8'),
      needs_ocr: false,   // Text pages skip OCR
      page_type: 'text',  // Text type
    };
  });

  await ctx.updateProgress({
    phase: 'uploading',
    total_pages: textExtraction.totalPages,
    pages_rendered: textExtraction.totalPages,
    pages_uploaded: textExtraction.totalPages,
  });

  // -------------------------------------------------------------------------
  // Step 7: Add relationships between text pages and extracted images
  // -------------------------------------------------------------------------
  await ctx.updateProgress({ phase: 'linking' });

  // Link text pages to their extracted images (has_extracted)
  for (const [pageNum, images] of imageExtraction.pageImageMap) {
    const textEntityIndex = textExtraction.pages.findIndex(p => p.pageNumber === pageNum);
    if (textEntityIndex === -1) continue;

    const textEntityId = createdTextEntities[textEntityIndex].id;
    const imageIds = images.map((img) => {
      const key = `${img.pageNumber}-${img.imageIndex}`;
      return imageEntityIds.get(key);
    }).filter((id): id is string => id !== undefined);

    if (imageIds.length > 0) {
      await updateEntity(client, textEntityId, {
        relationships_add: imageIds.map((imgId) => ({
          predicate: 'has_extracted',
          peer: imgId,
        })),
      });
    }
  }

  // Link source entity to text pages (images are linked via extracted_from)
  await updateEntity(client, job.entity_id, {
    relationships_add: createdTextEntityIds.map((id) => ({
      predicate: 'has_page',
      peer: id,
    })),
  });

  console.log(`[job] Linked source entity to ${createdTextEntityIds.length} pages and ${allImageResults.length} images`);

  // -------------------------------------------------------------------------
  // Step 8: Return combined results
  // -------------------------------------------------------------------------
  await ctx.updateProgress({ phase: 'complete' });

  // Combine text and image results
  // Text pages come first (they reference images via arke: URIs)
  // Images come after (they need OCR processing)
  const allResults: PageResult[] = [...textPageResults, ...allImageResults];
  const allEntityIds = [...createdTextEntityIds, ...allImageResults.map(r => r.entity_id)];

  const result: PdfResult = {
    source_id: job.entity_id,
    total_pages: textExtraction.totalPages,
    pages: allResults,
    entity_ids: allEntityIds,
  };

  console.log(`[job] Processing complete: ${textExtraction.totalPages} text pages + ${allImageResults.length} extracted images`);

  return {
    entity_ids: allEntityIds,
    result,
  };
}

/**
 * Process PDF in render mode - convert pages to JPEG images
 */
async function processRenderMode(
  ctx: ProcessContext<PdfJob>,
  pdfBuffer: Buffer,
  job: PdfJob,
  client: ReturnType<typeof createArkeClient>,
): Promise<ProcessResult<PdfResult>> {
  // -------------------------------------------------------------------------
  // Save PDF to temp and get page count
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

  // Build page results for response with routing properties
  const pageResults: PageResult[] = renderedPages.map((page, i) => ({
    page_number: page.pageNumber,
    entity_id: createdEntities[i].id,
    width: page.width,
    height: page.height,
    size_bytes: page.buffer.length,
    // Routing properties for rhiza scatter routing
    needs_ocr: true,     // Rendered pages need OCR
    page_type: 'image',  // Rendered pages are JPEG images
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
