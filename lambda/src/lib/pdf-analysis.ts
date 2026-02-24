/**
 * PDF Analysis Module
 *
 * Uses unpdf to analyze PDF structure and detect type (scanned vs digital).
 */

import { getDocumentProxy } from 'unpdf';
import {
  detectPdfType,
  type DetectionResult,
  type PageStructureAnalysis,
  type TextRenderingAnalysis,
} from './detection.js';

// =============================================================================
// PDF.js Operator Constants
// =============================================================================

const OPS = {
  paintImageXObject: 85,
  paintImageXObjectRepeat: 88,
  paintJpegXObject: 82,
  paintImageMaskXObject: 83,
  showText: 50,
  showSpacedText: 51,
  nextLineShowText: 53,
  nextLineSetSpacingShowText: 54,
  moveTo: 19,
  lineTo: 20,
  curveTo: 21,
  curveTo2: 22,
  curveTo3: 23,
  rectangle: 25,
  setTextRenderingMode: 49,
  setFont: 56,
};

// =============================================================================
// Page Structure Analysis
// =============================================================================

/**
 * Analyze page structure for detection
 */
async function analyzePageStructure(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  maxPages: number = 5
): Promise<PageStructureAnalysis[]> {
  const results: PageStructureAnalysis[] = [];
  const pagesToAnalyze = Math.min(pdf.numPages, maxPages);

  for (let pageNum = 1; pageNum <= pagesToAnalyze; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();

      let imageCount = 0;
      let largestImageArea = 0;
      let totalImageArea = 0;
      let textOperatorCount = 0;
      let pathOperatorCount = 0;

      for (let i = 0; i < ops.fnArray.length; i++) {
        const op = ops.fnArray[i];

        if (
          op === OPS.paintImageXObject ||
          op === OPS.paintJpegXObject ||
          op === OPS.paintImageXObjectRepeat ||
          op === OPS.paintImageMaskXObject
        ) {
          imageCount++;
          const imgName = ops.argsArray[i]?.[0];
          if (imgName) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const objs = (page as any).objs;
              if (objs) {
                const imgObj = objs.get(imgName);
                if (imgObj && imgObj.width && imgObj.height) {
                  const area = imgObj.width * imgObj.height;
                  totalImageArea += area;
                  if (area > largestImageArea) {
                    largestImageArea = area;
                  }
                }
              }
            } catch {
              const pageArea = viewport.width * viewport.height;
              if (largestImageArea === 0) {
                largestImageArea = pageArea * 0.9;
                totalImageArea = pageArea * 0.9;
              }
            }
          }
        }

        if (
          op === OPS.showText ||
          op === OPS.showSpacedText ||
          op === OPS.nextLineShowText ||
          op === OPS.nextLineSetSpacingShowText
        ) {
          textOperatorCount++;
        }

        if (
          op === OPS.moveTo ||
          op === OPS.lineTo ||
          op === OPS.curveTo ||
          op === OPS.curveTo2 ||
          op === OPS.curveTo3 ||
          op === OPS.rectangle
        ) {
          pathOperatorCount++;
        }
      }

      const pageWidth = viewport.width;
      const pageHeight = viewport.height;
      const pageArea = pageWidth * pageHeight;
      const hasFullPageImage = largestImageArea > pageArea * 0.8;

      results.push({
        pageNumber: pageNum,
        pageWidth,
        pageHeight,
        imageCount,
        largestImageArea,
        totalImageArea,
        textOperatorCount,
        pathOperatorCount,
        hasFullPageImage,
      });
    } catch (error) {
      console.warn(`[analyzePageStructure] Error analyzing page ${pageNum}:`, error);
    }
  }

  return results;
}

// =============================================================================
// Text Rendering Mode Analysis
// =============================================================================

/**
 * Analyze text rendering for detection
 */
async function analyzeTextRendering(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  maxPages: number = 5
): Promise<TextRenderingAnalysis[]> {
  const results: TextRenderingAnalysis[] = [];
  const pagesToAnalyze = Math.min(pdf.numPages, maxPages);

  for (let pageNum = 1; pageNum <= pagesToAnalyze; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const ops = await page.getOperatorList();

      let totalTextOperators = 0;
      let invisibleTextOperators = 0;
      let visibleTextOperators = 0;
      let hasGlyphlessFont = false;
      let currentRenderingMode = 0;

      for (let i = 0; i < ops.fnArray.length; i++) {
        const op = ops.fnArray[i];

        if (op === OPS.setTextRenderingMode) {
          currentRenderingMode = ops.argsArray[i]?.[0] ?? 0;
        }

        if (op === OPS.setFont) {
          const fontName = ops.argsArray[i]?.[0] ?? '';
          if (typeof fontName === 'string' && (fontName.includes('GlyphLess') || fontName.includes('glyphless'))) {
            hasGlyphlessFont = true;
          }
        }

        if (
          op === OPS.showText ||
          op === OPS.showSpacedText ||
          op === OPS.nextLineShowText ||
          op === OPS.nextLineSetSpacingShowText
        ) {
          totalTextOperators++;
          if (currentRenderingMode === 3) {
            invisibleTextOperators++;
          } else {
            visibleTextOperators++;
          }
        }
      }

      results.push({
        pageNumber: pageNum,
        totalTextOperators,
        invisibleTextOperators,
        visibleTextOperators,
        hasGlyphlessFont,
      });
    } catch (error) {
      console.warn(`[analyzeTextRendering] Error analyzing page ${pageNum}:`, error);
    }
  }

  return results;
}

// =============================================================================
// Main Detection Function
// =============================================================================

export type ProcessingMode = 'auto' | 'render' | 'extract';

/**
 * Detect PDF type from buffer
 *
 * @param pdfBuffer - PDF file content as Buffer
 * @param mode - Processing mode ('auto' runs detection, others force the mode)
 * @returns Detection result
 */
export async function detectPdfTypeFromBuffer(
  pdfBuffer: Buffer,
  mode: ProcessingMode = 'auto'
): Promise<DetectionResult> {
  // Handle forced modes
  if (mode === 'render') {
    return {
      pdfType: 'scanned',
      confidence: 1.0,
      method: 'forced',
      details: { reason: 'Forced render mode' },
    };
  }

  if (mode === 'extract') {
    return {
      pdfType: 'digital',
      confidence: 1.0,
      method: 'forced',
      details: { reason: 'Forced extract mode' },
    };
  }

  // Auto detection
  console.log('[detection] Running 3-tier detection...');
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));

  // Get metadata
  const metadata = await pdf.getMetadata();
  const info = metadata.info as Record<string, unknown> | undefined;
  const producer = (info?.Producer as string) || undefined;
  const creator = (info?.Creator as string) || undefined;

  console.log(`[detection] Producer: ${producer || 'N/A'}, Creator: ${creator || 'N/A'}`);

  // Run analysis
  const pageStructure = await analyzePageStructure(pdf, 5);
  const textRendering = await analyzeTextRendering(pdf, 5);

  // Run detection
  const detection = detectPdfType({
    producer,
    creator,
    pageStructure,
    textRendering,
  });

  console.log(`[detection] Result: ${detection.pdfType} (confidence: ${detection.confidence})`);
  return detection;
}

/**
 * Get page count from PDF buffer
 */
export async function getPageCountFromBuffer(pdfBuffer: Buffer): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  return pdf.numPages;
}
