/**
 * PDF type detection module
 *
 * Determines if a PDF is born-digital or scanned using three tiers:
 * 1. Producer/Creator metadata (most reliable - 95% confidence)
 * 2. Page structure analysis (full-page images = scanned - 85% confidence)
 * 3. Text rendering mode (invisible text = OCR layer = scanned - 80% confidence)
 *
 * If all tiers are inconclusive, defaults to 'scanned' for safety.
 */

export type PdfType = 'digital' | 'scanned';

export interface DetectionResult {
  pdfType: PdfType;
  confidence: number;
  method: 'producer' | 'structure' | 'text_rendering_mode' | 'default' | 'forced';
  details: {
    producer?: string;
    creator?: string;
    matchedPattern?: string;
    hasFullPageImages?: boolean;
    invisibleTextRatio?: number;
    reason?: string;
  };
}

// ============================================================================
// TIER 1: Comprehensive Producer/Creator Whitelist
// ============================================================================

/**
 * Known scanning/OCR software producers (lowercase for matching)
 *
 * Note: These are checked BEFORE digital producers, so more specific
 * patterns here will take precedence over generic ones in DIGITAL_PRODUCERS.
 */
const SCAN_PRODUCERS = [
  // Google Books (scanned books with OCR layer - must be before generic "google")
  'google books',

  // Major OCR software
  'abbyy',
  'finereader',
  'nuance',
  'omnipage',
  'readiris',
  'tesseract',
  'ocrmypdf',
  'ocr-my-pdf',

  // Document capture / scanning software
  'kofax',
  'kofax capture',
  'kofax express',
  'kofax vrs',
  'scansoft',
  'paperport',
  'paper capture',
  'clearimage',
  'clearscan',

  // Scanner manufacturer software
  'fujitsu',
  'paperstream',
  'scandall',
  'scansnap',
  'fi-',

  'canon',
  'canoscan',
  'capture perfect',
  'imageformula',

  'epson',
  'epson scan',
  'perfection',

  'hp scan',
  'hewlett-packard',
  'hp officejet',
  'hp scanjet',

  'xerox',
  'documate',

  'kodak',
  'kodak capture',
  'kodak alaris',
  'i1150',
  'i1180',
  'i1190',
  'i2000',
  'i3000',
  'i4000',
  'i5000',

  'brother',
  'brother scan',

  'ricoh',
  'panasonic',
  'plustek',
  'avision',
  'visioneer',

  // Third-party scanning software
  'vuescan',
  'naps2',
  'exactscan',
  'twain',
  'wia ',
  'sane ',
  'image capture',

  // Enterprise document management with scanning
  'ecopy',
  'nscan',
  'iris',
  'i.r.i.s.',
  'cvision',
  'pdftron ocr',
  'ocr sdk',

  // Mobile scanning apps
  'camscanner',
  'scanbot',
  'genius scan',
  'adobe scan',
  'microsoft lens',
  'office lens',
  'tiny scanner',
  'turboscan',
  'scanner pro',
  'swiftscan',
  'scannable',
  'prizmo',

  // Government/archive scanning systems
  'mekel',
  'microfilm',
  'microfiche',
  'digitization',
  'zeutschel',
  'bookeye',
  'kirtas',
  'treventus',
];

/**
 * Known born-digital software producers (lowercase for matching)
 */
const DIGITAL_PRODUCERS = [
  // Microsoft Office
  'microsoft',
  'ms word',
  'powerpoint',
  'excel',
  'office',
  'visio',
  'publisher',
  'onenote',

  // Google
  'google',
  'google docs',
  'google slides',
  'google sheets',

  // LibreOffice / OpenOffice
  'libreoffice',
  'openoffice',
  'libre office',
  'open office',
  'calligra',
  'abiword',

  // Apple
  'apple',
  'pages',
  'keynote',
  'numbers',
  'preview',
  'quartz',
  'pdfkit',
  'macos',
  'mac os',
  'ios',
  'core graphics',

  // Web browsers
  'chrome',
  'chromium',
  'skia',
  'firefox',
  'mozilla',
  'gecko',
  'safari',
  'webkit',
  'edge',
  'blink',
  'headless',

  // Adobe creative tools (NOT Acrobat which can be OCR)
  'indesign',
  'illustrator',
  'photoshop',
  'framemaker',
  'acrobat distiller',
  'distiller',
  'pdfmaker',
  'adobe pdf library',

  // Desktop publishing
  'corel',
  'coreldraw',
  'affinity',
  'affinity publisher',
  'affinity designer',
  'quarkxpress',
  'quark',
  'scribus',
  'canva',
  'figma',
  'sketch',

  // LaTeX / TeX
  'latex',
  'pdflatex',
  'xelatex',
  'lualatex',
  'pdftex',
  'xetex',
  'luatex',
  'tex',
  'context',
  'dvipdfm',
  'dvips',
  'ps2pdf',

  // PDF libraries / generators
  'reportlab',
  'fpdf',
  'tcpdf',
  'mpdf',
  'dompdf',
  'wkhtmltopdf',
  'weasyprint',
  'prince',
  'princexml',
  'puppeteer',
  'playwright',
  'pdfmake',
  'jspdf',
  'pdf.js',
  'pdfkit',
  'itext',
  'itextsharp',
  'pdfbox',
  'pdfsharp',
  'mupdf',
  'pypdf',
  'pdfrw',
  'pikepdf',
  'borb',
  'pdfcpu',
  'hummus',
  'haru',
  'libharu',
  'cairo',
  'poppler',
  'ghostscript',
  'gpl ghostscript',
  'gnu ghostscript',
  'pdf creator',
  'pdfcreator',
  'pdf24',
  'bullzip',
  'cutepdf',
  'dopdf',
  'primopdf',

  // Enterprise PDF tools
  'nitro',
  'nitro pdf',
  'foxit',
  'foxit phantom',
  'foxit pdf',
  'nuance pdf',
  'power pdf',
  'pdf-xchange',
  'pdfxchange',
  'pdf architect',
  'soda pdf',
  'smallpdf',
  'sejda',
  'pdf expert',
  'pdf element',
  'pdfelement',
  'wondershare',
  'tracker software',
  'bluebeam',

  // CAD / Engineering
  'autocad',
  'solidworks',
  'revit',
  'inventor',
  'catia',
  'microstation',
  'vectorworks',
  'archicad',
  'rhino',

  // Other applications with PDF export
  'crystal reports',
  'jasper',
  'jasperreports',
  'ssrs',
  'tableau',
  'powerbi',
  'qlik',
  'sap',
  'oracle',
  'cognos',

  // Web / cloud platforms
  'docusign',
  'hellosign',
  'pandadoc',
  'docspring',
  'anvil',
  'pspdfkit',
  'apryse',
  'pdftron',

  // General indicators of digital creation
  'writer',
  'converter',
  'generator',
  'export',
  'print to pdf',
  'save as pdf',
  'virtual printer',
];

/**
 * Detect PDF type using metadata (Producer/Creator fields)
 *
 * @param producer - PDF Producer metadata
 * @param creator - PDF Creator metadata
 * @returns Detection result or null if inconclusive
 */
export function detectByMetadata(
  producer: string | undefined,
  creator: string | undefined
): DetectionResult | null {
  const prodLower = (producer || '').toLowerCase();
  const creatLower = (creator || '').toLowerCase();
  const combined = `${prodLower} ${creatLower}`;

  // Check for scanning software first (higher priority)
  for (const pattern of SCAN_PRODUCERS) {
    if (combined.includes(pattern)) {
      return {
        pdfType: 'scanned',
        confidence: 0.95,
        method: 'producer',
        details: {
          producer,
          creator,
          matchedPattern: pattern,
        },
      };
    }
  }

  // Check for born-digital software
  for (const pattern of DIGITAL_PRODUCERS) {
    if (combined.includes(pattern)) {
      return {
        pdfType: 'digital',
        confidence: 0.95,
        method: 'producer',
        details: {
          producer,
          creator,
          matchedPattern: pattern,
        },
      };
    }
  }

  return null; // Inconclusive
}

// ============================================================================
// TIER 2: Page Structure Analysis
// ============================================================================

export interface PageStructureAnalysis {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  imageCount: number;
  largestImageArea: number;
  totalImageArea: number;
  textOperatorCount: number;
  pathOperatorCount: number;
  hasFullPageImage: boolean;
}

/**
 * Detect PDF type by analyzing page structure
 *
 * Scanned PDFs typically have each page as a single full-page image
 * with no text operators (or only invisible text for OCR).
 */
export function detectByStructure(
  pageAnalysis: PageStructureAnalysis[]
): DetectionResult | null {
  if (pageAnalysis.length === 0) return null;

  // Count pages that look scanned (full-page image, no/few text operators)
  const scannedPageCount = pageAnalysis.filter((p) => {
    const pageArea = p.pageWidth * p.pageHeight;
    const imageCoverage = p.largestImageArea / pageArea;
    // Scanned: large image covering >80% of page AND minimal text operators
    return imageCoverage > 0.8 && p.textOperatorCount < 5;
  }).length;

  // Count pages that look born-digital (has text operators OR lots of vector paths)
  const digitalPageCount = pageAnalysis.filter((p) => {
    // Digital: has meaningful text operators OR complex vector graphics
    return p.textOperatorCount >= 10 || p.pathOperatorCount > 100;
  }).length;

  const scannedRatio = scannedPageCount / pageAnalysis.length;
  const digitalRatio = digitalPageCount / pageAnalysis.length;

  // Need strong majority to be conclusive
  if (scannedRatio >= 0.8) {
    return {
      pdfType: 'scanned',
      confidence: 0.85,
      method: 'structure',
      details: {
        hasFullPageImages: true,
        reason: `${scannedPageCount}/${pageAnalysis.length} pages have full-page images with no text`,
      },
    };
  }

  if (digitalRatio >= 0.8) {
    return {
      pdfType: 'digital',
      confidence: 0.85,
      method: 'structure',
      details: {
        hasFullPageImages: false,
        reason: `${digitalPageCount}/${pageAnalysis.length} pages have text operators or vector graphics`,
      },
    };
  }

  return null; // Inconclusive - mixed or unclear structure
}

// ============================================================================
// TIER 3: Text Rendering Mode Detection
// ============================================================================

export interface TextRenderingAnalysis {
  pageNumber: number;
  totalTextOperators: number;
  invisibleTextOperators: number;
  visibleTextOperators: number;
  hasGlyphlessFont: boolean;
}

/**
 * Detect PDF type by analyzing text rendering mode
 *
 * OCR'd PDFs have text in "invisible" rendering mode (mode 3, "3 Tr" operator).
 * This creates a searchable layer on top of scanned images.
 */
export function detectByTextRendering(
  textAnalysis: TextRenderingAnalysis[]
): DetectionResult | null {
  if (textAnalysis.length === 0) return null;

  let totalInvisible = 0;
  let totalVisible = 0;
  let hasGlyphless = false;

  for (const page of textAnalysis) {
    totalInvisible += page.invisibleTextOperators;
    totalVisible += page.visibleTextOperators;
    if (page.hasGlyphlessFont) hasGlyphless = true;
  }

  const totalText = totalInvisible + totalVisible;
  if (totalText === 0) return null; // No text to analyze

  const invisibleRatio = totalInvisible / totalText;

  // If most text is invisible (OCR layer), it's a scanned document
  if (invisibleRatio > 0.8 || hasGlyphless) {
    return {
      pdfType: 'scanned',
      confidence: 0.80,
      method: 'text_rendering_mode',
      details: {
        invisibleTextRatio: invisibleRatio,
        reason: hasGlyphless
          ? 'Uses GlyphLessFont (Tesseract OCR)'
          : `${Math.round(invisibleRatio * 100)}% of text is invisible (OCR layer)`,
      },
    };
  }

  // If most text is visible, it's born-digital
  if (invisibleRatio < 0.2 && totalVisible > 0) {
    return {
      pdfType: 'digital',
      confidence: 0.80,
      method: 'text_rendering_mode',
      details: {
        invisibleTextRatio: invisibleRatio,
        reason: `${Math.round((1 - invisibleRatio) * 100)}% of text is visible (native text)`,
      },
    };
  }

  return null; // Inconclusive - mixed text modes
}

// ============================================================================
// Main Detection Function
// ============================================================================

export interface DetectionOptions {
  // Tier 1: Metadata
  producer?: string;
  creator?: string;

  // Tier 2: Structure
  pageStructure?: PageStructureAnalysis[];

  // Tier 3: Text rendering
  textRendering?: TextRenderingAnalysis[];
}

/**
 * Main detection function - tries methods in order of reliability
 *
 * Tier 1: Producer/Creator metadata (95% confidence)
 * Tier 2: Page structure analysis (85% confidence)
 * Tier 3: Text rendering mode (80% confidence)
 * Default: Assume scanned if all tiers inconclusive
 */
export function detectPdfType(options: DetectionOptions): DetectionResult {
  // Tier 1: Try metadata-based detection (most reliable)
  const metadataResult = detectByMetadata(options.producer, options.creator);
  if (metadataResult) {
    return metadataResult;
  }

  // Tier 2: Try structure-based detection
  if (options.pageStructure && options.pageStructure.length > 0) {
    const structureResult = detectByStructure(options.pageStructure);
    if (structureResult) {
      return structureResult;
    }
  }

  // Tier 3: Try text rendering mode detection
  if (options.textRendering && options.textRendering.length > 0) {
    const renderingResult = detectByTextRendering(options.textRendering);
    if (renderingResult) {
      return renderingResult;
    }
  }

  // Default: If all tiers inconclusive, assume scanned for safety
  return {
    pdfType: 'scanned',
    confidence: 0.5,
    method: 'default',
    details: {
      reason: 'All detection tiers inconclusive, defaulting to scanned',
    },
  };
}
