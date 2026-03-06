/**
 * Create a simple digital PDF for testing extract mode
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'fs';

async function createTestPdf() {
  const pdfDoc = await PDFDocument.create();
  
  // Set metadata to clearly identify as digital
  pdfDoc.setTitle('Test Digital Document');
  pdfDoc.setAuthor('Test Author');
  pdfDoc.setCreator('Microsoft Word');  // Common digital PDF creator
  pdfDoc.setProducer('pdf-lib test');
  pdfDoc.setSubject('Testing PDF extraction');
  
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  // Page 1: Title page
  const page1 = pdfDoc.addPage([612, 792]); // Letter size
  page1.drawText('Test Document for PDF Extraction', {
    x: 72,
    y: 700,
    size: 24,
    font: boldFont,
    color: rgb(0, 0, 0),
  });
  page1.drawText('This is a native/digital PDF created with pdf-lib.', {
    x: 72,
    y: 650,
    size: 14,
    font,
  });
  page1.drawText('It contains searchable text that can be extracted directly.', {
    x: 72,
    y: 630,
    size: 14,
    font,
  });
  page1.drawText('No OCR is needed for this type of PDF.', {
    x: 72,
    y: 610,
    size: 14,
    font,
  });
  page1.drawText('The text should be stored in the text property of each page entity.', {
    x: 72,
    y: 590,
    size: 14,
    font,
  });

  // Page 2: More content
  const page2 = pdfDoc.addPage([612, 792]);
  page2.drawText('Chapter 1: Introduction', {
    x: 72,
    y: 700,
    size: 18,
    font: boldFont,
  });
  
  const paragraph = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. 
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. 
Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.`;
  
  let y = 660;
  for (const line of paragraph.split('\n')) {
    page2.drawText(line.trim(), { x: 72, y, size: 12, font });
    y -= 20;
  }

  page2.drawText('This paragraph demonstrates multi-line text extraction.', {
    x: 72,
    y: y - 20,
    size: 12,
    font,
  });

  // Page 3: Simple content
  const page3 = pdfDoc.addPage([612, 792]);
  page3.drawText('Chapter 2: Conclusion', {
    x: 72,
    y: 700,
    size: 18,
    font: boldFont,
  });
  page3.drawText('This is the final page of our test document.', {
    x: 72,
    y: 660,
    size: 12,
    font,
  });
  page3.drawText('The PDF processor should extract text from all three pages.', {
    x: 72,
    y: 640,
    size: 12,
    font,
  });
  page3.drawText('Each page should become a separate entity with a text property.', {
    x: 72,
    y: 620,
    size: 12,
    font,
  });

  // Save the PDF
  const pdfBytes = await pdfDoc.save();
  writeFileSync('test-digital.pdf', pdfBytes);
  console.log('Created test-digital.pdf (3 pages) with Microsoft Word as creator');
}

createTestPdf().catch(console.error);
