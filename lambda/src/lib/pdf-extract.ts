/**
 * PDF Text Extraction Module
 *
 * Extracts text from digital PDFs using unpdf.
 * For digital PDFs, this extracts native text that can go directly
 * to knowledge graph extraction, skipping OCR.
 */

import { getDocumentProxy } from 'unpdf';

// =============================================================================
// Types
// =============================================================================

/**
 * Extracted text from a single page
 */
export interface ExtractedPage {
  pageNumber: number;
  text: string;
  /** Approximate character count */
  charCount: number;
}

/**
 * Result of text extraction
 */
export interface ExtractionResult {
  totalPages: number;
  pages: ExtractedPage[];
  /** Total characters extracted across all pages */
  totalChars: number;
}

// =============================================================================
// Text Extraction
// =============================================================================

/**
 * Extract text from a PDF buffer
 *
 * @param pdfBuffer - PDF file content as Buffer
 * @param onProgress - Optional callback for progress updates
 * @returns Extraction result with text for each page
 */
export async function extractTextFromBuffer(
  pdfBuffer: Buffer,
  onProgress?: (extracted: number, total: number) => Promise<void>
): Promise<ExtractionResult> {
  console.log('[extract] Starting text extraction...');

  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const totalPages = pdf.numPages;

  console.log(`[extract] PDF has ${totalPages} pages`);

  const pages: ExtractedPage[] = [];
  let totalChars = 0;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Combine text items into page text
      // textContent.items contains objects with 'str' property
      const pageText = textContent.items
        .map((item: unknown) => {
          // Type assertion - unpdf returns items with str property
          const textItem = item as { str?: string };
          return textItem.str || '';
        })
        .join('');

      const charCount = pageText.length;
      totalChars += charCount;

      pages.push({
        pageNumber: pageNum,
        text: pageText,
        charCount,
      });

      console.log(`[extract] Page ${pageNum}: ${charCount} chars`);

      if (onProgress) {
        await onProgress(pageNum, totalPages);
      }
    } catch (error) {
      console.error(`[extract] Error extracting page ${pageNum}:`, error);
      // Add empty page on error to maintain page numbering
      pages.push({
        pageNumber: pageNum,
        text: '',
        charCount: 0,
      });
    }
  }

  console.log(`[extract] Extraction complete: ${totalPages} pages, ${totalChars} total chars`);

  return {
    totalPages,
    pages,
    totalChars,
  };
}

/**
 * Extract text from a single page
 *
 * @param pdfBuffer - PDF file content as Buffer
 * @param pageNumber - Page number (1-indexed)
 * @returns Extracted page text
 */
export async function extractPageText(
  pdfBuffer: Buffer,
  pageNumber: number
): Promise<ExtractedPage> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));

  if (pageNumber < 1 || pageNumber > pdf.numPages) {
    throw new Error(`Page ${pageNumber} out of range (1-${pdf.numPages})`);
  }

  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();

  const pageText = textContent.items
    .map((item: unknown) => {
      const textItem = item as { str?: string };
      return textItem.str || '';
    })
    .join('');

  return {
    pageNumber,
    text: pageText,
    charCount: pageText.length,
  };
}
