import { PdfLayoutSettings } from "@/types";

export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;
export const PAGE_MARGIN_MM = 5;
export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const MM_PER_LAYOUT_PX = MM_PER_INCH / CSS_PX_PER_INCH;
export const CSS_PX_PER_PDF_POINT = CSS_PX_PER_INCH / 72;
export const MM_TO_CSS_PX = CSS_PX_PER_INCH / MM_PER_INCH;

export function getCardDimensionsMm(layout: Pick<PdfLayoutSettings, "columns" | "rows" | "boxSpacing">) {
  const availableWidth = PAGE_WIDTH_MM - 2 * PAGE_MARGIN_MM;
  const availableHeight = PAGE_HEIGHT_MM - 2 * PAGE_MARGIN_MM;
  return {
    width: (availableWidth - layout.boxSpacing * (layout.columns - 1)) / layout.columns,
    height: (availableHeight - layout.boxSpacing * (layout.rows - 1)) / layout.rows,
  };
}

export function layoutPxToMm(position: number): number {
  return position * MM_PER_LAYOUT_PX;
}

export function pdfPointsToPreviewPx(points: number, previewScale: number): number {
  return points * CSS_PX_PER_PDF_POINT * previewScale;
}
