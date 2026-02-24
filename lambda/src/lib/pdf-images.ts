/**
 * PDF Image Extraction Module
 *
 * Extracts embedded images from digital PDFs using unpdf.
 * Images are converted to JPEG format for downstream OCR processing.
 */

import { getDocumentProxy } from 'unpdf';
import * as jpeg from 'jpeg-js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extracted image from a PDF page
 */
export interface ExtractedImage {
  /** Page number where image was found (1-indexed) */
  pageNumber: number;
  /** Image index within the page (0-indexed) */
  imageIndex: number;
  /** Image reference name in PDF (e.g., "Im0") */
  imageName: string;
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** JPEG encoded image data */
  buffer: Buffer;
  /** Image size in bytes */
  size: number;
}

/**
 * Result of image extraction from PDF
 */
export interface ImageExtractionResult {
  totalPages: number;
  totalImages: number;
  images: ExtractedImage[];
  /** Map of page number to image indices for text replacement */
  pageImageMap: Map<number, ExtractedImage[]>;
}

// =============================================================================
// PDF.js Operator Constants
// =============================================================================

const OPS = {
  paintImageXObject: 85,
  paintImageXObjectRepeat: 88,
  paintJpegXObject: 82,
  paintImageMaskXObject: 83,
};

// =============================================================================
// Image Extraction
// =============================================================================

/**
 * Extract all embedded images from a PDF buffer
 *
 * @param pdfBuffer - PDF file content as Buffer
 * @param quality - JPEG quality for encoding (1-100, default: 85)
 * @param onProgress - Optional progress callback
 * @returns Extraction result with all images
 */
export async function extractImagesFromBuffer(
  pdfBuffer: Buffer,
  quality: number = 85,
  onProgress?: (page: number, total: number, imagesFound: number) => Promise<void>
): Promise<ImageExtractionResult> {
  console.log('[images] Starting image extraction...');

  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const totalPages = pdf.numPages;

  const images: ExtractedImage[] = [];
  const pageImageMap = new Map<number, ExtractedImage[]>();

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const pageImages = await extractImagesFromPage(pdf, pageNum, quality);

      if (pageImages.length > 0) {
        images.push(...pageImages);
        pageImageMap.set(pageNum, pageImages);
        console.log(`[images] Page ${pageNum}: extracted ${pageImages.length} images`);
      }

      if (onProgress) {
        await onProgress(pageNum, totalPages, images.length);
      }
    } catch (error) {
      console.warn(`[images] Error extracting images from page ${pageNum}:`, error);
    }
  }

  console.log(`[images] Extraction complete: ${images.length} images from ${totalPages} pages`);

  return {
    totalPages,
    totalImages: images.length,
    images,
    pageImageMap,
  };
}

/**
 * Extract images from a single PDF page
 */
async function extractImagesFromPage(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  pageNum: number,
  quality: number
): Promise<ExtractedImage[]> {
  const page = await pdf.getPage(pageNum);
  const ops = await page.getOperatorList();
  const extractedImages: ExtractedImage[] = [];

  // Track which images we've already processed (avoid duplicates)
  const processedImages = new Set<string>();
  let imageIndex = 0;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i];

    // Check for image paint operators
    if (
      op === OPS.paintImageXObject ||
      op === OPS.paintJpegXObject ||
      op === OPS.paintImageXObjectRepeat
    ) {
      const imgName = ops.argsArray[i]?.[0];
      if (!imgName || typeof imgName !== 'string') continue;

      // Skip if already processed
      if (processedImages.has(imgName)) continue;
      processedImages.add(imgName);

      try {
        // Access page objects to get image data
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const objs = (page as any).objs;
        if (!objs) continue;

        // Get the image object - this resolves the image data
        const imgObj = await getImageObject(objs, imgName);
        if (!imgObj) continue;

        const { width, height, data, kind } = imgObj;
        if (!width || !height || !data) continue;

        // Skip very small images (likely artifacts)
        if (width < 50 || height < 50) continue;

        // Convert to JPEG
        const jpegBuffer = encodeToJpeg(data, width, height, kind, quality);
        if (!jpegBuffer) continue;

        extractedImages.push({
          pageNumber: pageNum,
          imageIndex,
          imageName: imgName,
          width,
          height,
          buffer: jpegBuffer,
          size: jpegBuffer.length,
        });

        imageIndex++;
      } catch (error) {
        console.warn(`[images] Failed to extract image ${imgName} from page ${pageNum}:`, error);
      }
    }
  }

  return extractedImages;
}

/**
 * Get image object from page objects store
 * pdf.js stores objects lazily, so we may need to wait for them
 */
async function getImageObject(
  objs: { get: (name: string) => unknown },
  imgName: string
): Promise<{
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  kind: number;
} | null> {
  try {
    const imgObj = objs.get(imgName) as {
      width?: number;
      height?: number;
      data?: Uint8Array | Uint8ClampedArray;
      kind?: number;
    } | null;

    if (!imgObj || !imgObj.width || !imgObj.height || !imgObj.data) {
      return null;
    }

    return {
      width: imgObj.width,
      height: imgObj.height,
      data: imgObj.data,
      kind: imgObj.kind ?? 1, // Default to RGB
    };
  } catch {
    return null;
  }
}

/**
 * Encode raw pixel data to JPEG
 *
 * pdf.js image kinds:
 * - 1: GRAYSCALE (1 component)
 * - 2: RGB (3 components)
 * - 3: RGBA (4 components)
 */
function encodeToJpeg(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  kind: number,
  quality: number
): Buffer | null {
  try {
    // jpeg-js expects RGBA data
    let rgbaData: Uint8Array;

    if (kind === 1) {
      // Grayscale to RGBA
      rgbaData = new Uint8Array(width * height * 4);
      for (let i = 0; i < data.length; i++) {
        const j = i * 4;
        rgbaData[j] = data[i];     // R
        rgbaData[j + 1] = data[i]; // G
        rgbaData[j + 2] = data[i]; // B
        rgbaData[j + 3] = 255;     // A
      }
    } else if (kind === 2) {
      // RGB to RGBA
      rgbaData = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const srcIdx = i * 3;
        const dstIdx = i * 4;
        rgbaData[dstIdx] = data[srcIdx];         // R
        rgbaData[dstIdx + 1] = data[srcIdx + 1]; // G
        rgbaData[dstIdx + 2] = data[srcIdx + 2]; // B
        rgbaData[dstIdx + 3] = 255;              // A
      }
    } else if (kind === 3) {
      // Already RGBA
      rgbaData = data instanceof Uint8Array ? data : new Uint8Array(data);
    } else {
      console.warn(`[images] Unknown image kind: ${kind}`);
      return null;
    }

    const rawImageData = {
      data: rgbaData,
      width,
      height,
    };

    const encoded = jpeg.encode(rawImageData, quality);
    return Buffer.from(encoded.data);
  } catch (error) {
    console.warn('[images] Failed to encode JPEG:', error);
    return null;
  }
}

/**
 * Transform extracted text to include arke: URI references for images
 *
 * Inserts image placeholders at the end of each page's text where images were found.
 * The placeholders use markdown image syntax: ![img-N](arke:ENTITY_ID)
 *
 * @param pageTexts - Map of page number to extracted text
 * @param pageImageMap - Map of page number to extracted images
 * @param imageEntityIds - Map of image key (pageNum-imageIndex) to entity ID
 * @returns Map of page number to transformed text
 */
export function transformTextWithImageRefs(
  pageTexts: Map<number, string>,
  pageImageMap: Map<number, ExtractedImage[]>,
  imageEntityIds: Map<string, string>
): Map<number, string> {
  const transformed = new Map<number, string>();

  for (const [pageNum, text] of pageTexts) {
    const pageImages = pageImageMap.get(pageNum);

    if (!pageImages || pageImages.length === 0) {
      transformed.set(pageNum, text);
      continue;
    }

    // Build image reference section
    const imageRefs = pageImages
      .map((img) => {
        const key = `${img.pageNumber}-${img.imageIndex}`;
        const entityId = imageEntityIds.get(key);
        if (!entityId) return null;
        return `![img-${img.imageIndex}](arke:${entityId})`;
      })
      .filter(Boolean)
      .join('\n\n');

    // Append image references to page text
    const transformedText = imageRefs
      ? `${text}\n\n---\n\n${imageRefs}`
      : text;

    transformed.set(pageNum, transformedText);
  }

  return transformed;
}
