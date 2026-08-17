import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { GeneratorSettings, PdfLayoutSettings, PrintOptions } from "@/types";
import {
  getCardDimensionsMm,
  layoutPxToMm,
  PAGE_MARGIN_MM,
} from "@/utils/cardGeometry";

/** jsPDF needs to know the real image format — treating a PNG/WEBP upload as
 * "JPEG" can corrupt or blank out the rendered background. */
function detectImageFormat(dataUrl: string): "PNG" | "WEBP" | "JPEG" {
  const match = dataUrl.match(/^data:image\/(\w+);/);
  const fmt = match?.[1]?.toUpperCase();
  if (fmt === "PNG") return "PNG";
  if (fmt === "WEBP") return "WEBP";
  return "JPEG";
}

const CAIRO_FONT_FILE = "Cairo-Variable.ttf";
const CAIRO_FONT_FAMILY = "Cairo";
let cachedCairoBase64: string | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Fetches and registers the real Cairo TTF with jsPDF so it actually
 * appears in the exported PDF (not just the on-screen CSS preview). The
 * font bytes are cached after the first fetch, but registration itself
 * must be repeated on every new jsPDF() instance — jsPDF doesn't share
 * registered fonts across instances. */
async function ensureCairoFontRegistered(doc: jsPDF): Promise<void> {
  if (!cachedCairoBase64) {
    const res = await fetch(`/fonts/${CAIRO_FONT_FILE}`);
    if (!res.ok) throw new Error("تعذّر تحميل خط Cairo للطباعة");
    const buffer = await res.arrayBuffer();
    cachedCairoBase64 = arrayBufferToBase64(buffer);
  }

  // Identity-H preserves the embedded TTF's Unicode glyph mapping, including
  // Arabic characters, instead of allowing jsPDF to substitute a core font.
  doc.addFileToVFS(CAIRO_FONT_FILE, cachedCairoBase64);
  doc.addFont(CAIRO_FONT_FILE, CAIRO_FONT_FAMILY, "normal", "Identity-H");
  if (!doc.getFontList()[CAIRO_FONT_FAMILY]?.includes("normal")) {
    throw new Error("تعذّر تضمين خط Cairo داخل ملف PDF");
  }
}

export function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  triggerDownload(blob, filename);
}

export function exportAsExcel(
  numbers: string[],
  settings: Pick<GeneratorSettings, "customer" | "profile" | "comment">,
  filename: string
) {
  const rows = numbers.map((number) => ({
    الرقم: number,
    العميل: settings.customer,
    البروفايل: settings.profile,
    التعليق: settings.comment || "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Numbers");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

/** Returns the generated Excel workbook as a Blob (for saving to the Library). */
export function exportAsExcelBlob(
  numbers: string[],
  settings: Pick<GeneratorSettings, "customer" | "profile" | "comment">
): Blob {
  const rows = numbers.map((number) => ({
    الرقم: number,
    العميل: settings.customer,
    البروفايل: settings.profile,
    التعليق: settings.comment || "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Numbers");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function loadImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("تعذّر تحميل صورة الخلفية"));
    img.src = dataUrl;
  });
}

export async function generateCardsPdf(
  numbers: string[],
  layout: PdfLayoutSettings,
  printOptions: PrintOptions
): Promise<Blob> {
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const pdfFontName = layout.font === "cairo" ? CAIRO_FONT_FAMILY : layout.font || "helvetica";
  if (layout.font === "cairo") {
    await ensureCairoFontRegistered(doc);
  }
  doc.setLanguage("ar");

  const cardDimensions = getCardDimensionsMm(layout);
  const boxWidth = cardDimensions.width;
  const boxHeight = cardDimensions.height;
  const perPage = layout.columns * layout.rows;

  const today = new Date().toISOString().split("T")[0];

  // Preload the background image once (same image reused on every card) so we
  // know its real aspect ratio for "contain"/"cover" fitting.
  let imgDims: { width: number; height: number } | null = null;
  if (layout.backgroundImageDataUrl) {
    imgDims = await loadImageDimensions(layout.backgroundImageDataUrl);
  }

  let serial = printOptions.serialStartNumber;

  for (let i = 0; i < numbers.length; i++) {
    const pageIndex = Math.floor(i / perPage);
    const indexOnPage = i % perPage;
    const col = indexOnPage % layout.columns;
    const row = Math.floor(indexOnPage / layout.columns);

    if (indexOnPage === 0 && pageIndex > 0) doc.addPage();

    const x = PAGE_MARGIN_MM + col * (boxWidth + layout.boxSpacing);
    const y = PAGE_MARGIN_MM + row * (boxHeight + layout.boxSpacing);

    if (layout.backgroundImageDataUrl && imgDims) {
      const imgFormat = detectImageFormat(layout.backgroundImageDataUrl);
      if (layout.backgroundFit === "stretch") {
        doc.addImage(layout.backgroundImageDataUrl, imgFormat, x, y, boxWidth, boxHeight);
      } else {
        const imgRatio = imgDims.width / imgDims.height;
        const boxRatio = boxWidth / boxHeight;
        const scaleToBox =
          layout.backgroundFit === "contain"
            ? imgRatio > boxRatio
              ? boxWidth / imgDims.width
              : boxHeight / imgDims.height
            : imgRatio > boxRatio
              ? boxHeight / imgDims.height
              : boxWidth / imgDims.width;
        const drawWidth = imgDims.width * scaleToBox;
        const drawHeight = imgDims.height * scaleToBox;
        const offsetX = x + (boxWidth - drawWidth) / 2;
        const offsetY = y + (boxHeight - drawHeight) / 2;

        if (layout.backgroundFit === "cover") {
          // "cover" can overflow the card box, so clip to the box bounds first.
          doc.saveGraphicsState();
          doc.rect(x, y, boxWidth, boxHeight, null);
          doc.clip();
          doc.discardPath();
          doc.addImage(layout.backgroundImageDataUrl, imgFormat, offsetX, offsetY, drawWidth, drawHeight);
          doc.restoreGraphicsState();
        } else {
          doc.addImage(layout.backgroundImageDataUrl, imgFormat, offsetX, offsetY, drawWidth, drawHeight);
        }
      }
    }

    if (layout.useBorder) {
      doc.setLineWidth(layoutPxToMm(layout.borderWidth));
      doc.setDrawColor(layout.borderColor);
      doc.rect(x, y, boxWidth, boxHeight);
    }

    // baseline: "top" makes jsPDF's y-coordinate mean the TOP of the text,
    // matching how the CSS preview positions it (top-anchored). Without this,
    // jsPDF anchors to the text baseline, which sits lower than the box's
    // "top" — that's why the printed PDF looked higher/misaligned vs preview.
    doc.setFont(pdfFontName, pdfFontName === "Cairo" ? "normal" : layout.fontWeight === "bold" ? "bold" : "normal");
    doc.setTextColor(layout.textColor || "#000000");
    doc.setFontSize(layout.textSize);
    doc.text(numbers[i], x + layoutPxToMm(layout.textPositionX), y + layoutPxToMm(layout.textPositionY), {
      align: layout.textAlign === "right" ? "right" : layout.textAlign === "center" ? "center" : "left",
      angle: layout.textRotation || 0,
      baseline: "top",
    });

    if (printOptions.useSerialNumber) {
      doc.setFont(pdfFontName, "normal");
      doc.setTextColor(layout.serialColor || "#000000");
      doc.setFontSize(layout.serialNumberSize);
      doc.text(
        String(serial),
        x + layoutPxToMm(layout.serialPositionX),
        y + layoutPxToMm(layout.serialPositionY),
        { baseline: "top" }
      );
      serial++;
    }

    if (printOptions.useDatePrinting) {
      doc.setFont(pdfFontName, "normal");
      doc.setTextColor(layout.dateColor || "#000000");
      doc.setFontSize(layout.dateSize);
      doc.text(today, x + layoutPxToMm(layout.datePositionX), y + layoutPxToMm(layout.datePositionY), {
        baseline: "top",
      });
    }

    if (printOptions.useCustomText && printOptions.customText) {
      doc.setFont(pdfFontName, "normal");
      doc.setTextColor(layout.customTextColor || "#000000");
      doc.setFontSize(layout.customTextSize);
      doc.text(
        printOptions.customText,
        x + layoutPxToMm(layout.customTextPositionX),
        y + layoutPxToMm(layout.customTextPositionY),
        { baseline: "top" }
      );
    }
  }

  return doc.output("blob");
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export { triggerDownload };
