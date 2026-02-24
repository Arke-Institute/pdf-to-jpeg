/**
 * Test script for PDF detection and processing modes
 *
 * Tests:
 * 1. Auto mode detection
 * 2. Forced render mode
 * 3. Forced extract mode
 * 4. Routing properties (needs_ocr, page_type)
 *
 * Usage:
 *   npx tsx test-detection.ts <pdf-path> [mode]
 *
 * Examples:
 *   npx tsx test-detection.ts ./sample.pdf auto
 *   npx tsx test-detection.ts ./sample.pdf render
 *   npx tsx test-detection.ts ./sample.pdf extract
 */

import { readFileSync } from 'fs';
import { detectPdfTypeFromBuffer } from './src/lib/pdf-analysis.js';
import { extractTextFromBuffer } from './src/lib/pdf-extract.js';
import { extractImagesFromBuffer } from './src/lib/pdf-images.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npx tsx test-detection.ts <pdf-path> [mode]');
    console.log('Modes: auto (default), render, extract, detect-only');
    process.exit(1);
  }

  const pdfPath = args[0];
  const mode = (args[1] || 'auto') as 'auto' | 'render' | 'extract' | 'detect-only';

  console.log(`\n=== PDF Detection Test ===`);
  console.log(`PDF: ${pdfPath}`);
  console.log(`Mode: ${mode}\n`);

  // Read PDF
  const pdfBuffer = readFileSync(pdfPath);
  console.log(`PDF size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB\n`);

  // Run detection
  console.log(`--- Detection Phase ---`);
  const detection = await detectPdfTypeFromBuffer(pdfBuffer, mode === 'detect-only' ? 'auto' : mode);

  console.log(`PDF Type: ${detection.pdfType}`);
  console.log(`Confidence: ${(detection.confidence * 100).toFixed(0)}%`);
  console.log(`Method: ${detection.method}`);
  console.log(`Details:`, JSON.stringify(detection.details, null, 2));
  console.log();

  if (mode === 'detect-only') {
    console.log('Detection only mode - skipping extraction.\n');
    return;
  }

  // Determine processing mode
  let processingMode: 'render' | 'extract';
  if (mode === 'auto') {
    processingMode = detection.pdfType === 'digital' ? 'extract' : 'render';
    console.log(`Auto-detected: ${detection.pdfType} → ${processingMode} mode\n`);
  } else {
    processingMode = mode;
    console.log(`Forced mode: ${processingMode}\n`);
  }

  // Run appropriate extraction
  if (processingMode === 'extract') {
    console.log(`--- Text Extraction Phase ---`);
    const textResult = await extractTextFromBuffer(pdfBuffer);
    console.log(`Total pages: ${textResult.totalPages}`);
    console.log(`Total chars: ${textResult.totalChars}`);
    console.log();

    // Show sample of first page
    if (textResult.pages.length > 0) {
      const firstPage = textResult.pages[0];
      console.log(`Page 1 sample (first 500 chars):`);
      console.log(firstPage.text.slice(0, 500));
      console.log('...\n');
    }

    console.log(`--- Image Extraction Phase ---`);
    const imageResult = await extractImagesFromBuffer(pdfBuffer, 85);
    console.log(`Total images: ${imageResult.totalImages}`);

    if (imageResult.totalImages > 0) {
      console.log(`\nImages found:`);
      for (const img of imageResult.images) {
        console.log(`  - Page ${img.pageNumber}, img ${img.imageIndex}: ${img.width}x${img.height}, ${(img.size / 1024).toFixed(1)} KB`);
      }
    }
    console.log();

    // Show expected routing
    console.log(`--- Expected Output Routing ---`);
    console.log(`Text pages (${textResult.totalPages}):`);
    console.log(`  needs_ocr: false`);
    console.log(`  page_type: 'text'`);

    if (imageResult.totalImages > 0) {
      console.log(`\nExtracted images (${imageResult.totalImages}):`);
      console.log(`  needs_ocr: true`);
      console.log(`  page_type: 'image'`);
    }
  } else {
    console.log(`--- Render Mode ---`);
    console.log(`Would render all pages to JPEG using Ghostscript.`);
    console.log(`(Skipping actual render in test script)\n`);

    console.log(`--- Expected Output Routing ---`);
    console.log(`All pages:`);
    console.log(`  needs_ocr: true`);
    console.log(`  page_type: 'image'`);
  }

  console.log(`\n=== Test Complete ===\n`);
}

main().catch(console.error);
