import type { DocumentAnchor } from "./types";

// Keep this exhaustive: a repaired source must not inherit coordinates from a
// different document or from an embedded viewer of the missing source.
const anchorFields = {
  studyRange: true, anchorType: true, page: true, pageY: true, scrollRatio: true, fragmentText: true,
  line: true, ch: true, scrollTop: true, mdOffset: true, mdBefore: true, mdAfter: true, mdSelection: true,
  pdfLeft: true, pdfTop: true, pdfZoom: true, embeddedPdfPath: true, embeddedPdfIndex: true, embeddedPdfLine: true,
  canvasX: true, canvasY: true, canvasZoom: true, canvasNodeIds: true, canvasFilePaths: true, canvasPdfPath: true,
  canvasDocxPath: true, canvasPptxPath: true, canvasXlsxPath: true, canvasImagePath: true, canvasMediaPath: true,
  embeddedMediaPath: true, embeddedMediaIndex: true, embeddedMediaLine: true,
  epubLocation: true, epubChapter: true, epubPercentage: true, epubScrollX: true, epubScrollY: true,
  epubStorageKey: true, epubStorageValue: true, imageX: true, imageY: true, imageNaturalWidth: true, imageNaturalHeight: true,
  docxPage: true, docxPageY: true, docxScrollX: true, docxScrollY: true, docxZoom: true, docxTextOffset: true, docxBefore: true, docxAfter: true,
  pptxSlide: true, pptxX: true, pptxY: true, pptxZoom: true, xlsxSheetIndex: true, xlsxSheetName: true,
  xlsxStartRow: true, xlsxStartColumn: true, xlsxEndRow: true, xlsxEndColumn: true, xlsxScrollLeft: true, xlsxScrollTop: true, xlsxZoom: true,
  excalidrawElementIds: true, excalidrawScrollX: true, excalidrawScrollY: true, excalidrawZoom: true,
  mediaTime: true, mediaDuration: true, mediaProgress: true, mediaKind: true, mediaRange: true, mediaSourceVersion: true,
  textLine: true, textColumn: true, textOffset: true, textBefore: true, textAfter: true, textSelection: true, textKind: true, canvasTextPath: true
} satisfies Record<keyof DocumentAnchor, true>;

export const SOURCE_REPAIR_ANCHOR_FIELDS = Object.keys(anchorFields) as Array<keyof DocumentAnchor>;
