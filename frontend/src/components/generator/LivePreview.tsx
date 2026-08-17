import { PdfLayoutSettings, PrintOptions } from "@/types";
import {
  getCardDimensionsMm,
  MM_TO_CSS_PX,
  PAGE_WIDTH_MM,
  pdfPointsToPreviewPx,
} from "@/utils/cardGeometry";
import { useCallback, useMemo, useRef, useState } from "react";

interface Props {
  sampleNumber: string;
  layout: PdfLayoutSettings;
  /** What to actually render. Omit to show every element (used by the Templates page design view). */
  printOptions?: PrintOptions;
  /** Allow dragging elements to reposition them. Off by default — only the Templates editor sets this. */
  editable?: boolean;
  /** Called with a partial layout update when the user drags an element (only relevant if editable). */
  onLayoutChange?: (partial: Partial<PdfLayoutSettings>) => void;
}


const DESIGN_MODE_OPTIONS: PrintOptions = {
  useSerialNumber: true,
  serialStartNumber: 1,
  useDatePrinting: true,
  useCustomText: true,
  customText: "نص اختياري",
};

/** Maps the stored font key to an actual usable CSS font-family for the preview. */
function cssFontFamily(font: string): string {
  if (font === "cairo") return "'Cairo', sans-serif";
  if (font === "times") return "'Times New Roman', serif";
  if (font === "courier") return "'Courier New', monospace";
  return "Helvetica, Arial, sans-serif";
}

function previewFontSize(pdfPoints: number, scale: number): string {
  return `${pdfPointsToPreviewPx(pdfPoints, scale)}px`;
}

function anchorTransform(align: "left" | "center" | "right", rotation = 0): string | undefined {
  const translate = align === "center" ? "translateX(-50%)" : align === "right" ? "translateX(-100%)" : "";
  const rotate = rotation ? `rotate(${rotation}deg)` : "";
  return [translate, rotate].filter(Boolean).join(" ") || undefined;
}

function anchorOrigin(align: "left" | "center" | "right"): string {
  return `${align} top`;
}

type DragTarget = "text" | "serial" | "date" | "customText" | null;

export function LivePreview({
  sampleNumber,
  layout,
  printOptions = DESIGN_MODE_OPTIONS,
  editable = false,
  onLayoutChange,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<DragTarget>(null);

  const { boxWidthPx, boxHeightPx, baseScale } = useMemo(() => {
    const card = getCardDimensionsMm(layout);
    const s = Math.min(1, 600 / PAGE_WIDTH_MM);
    return {
      boxWidthPx: card.width * s * MM_TO_CSS_PX,
      boxHeightPx: card.height * s * MM_TO_CSS_PX,
      baseScale: s,
    };
  }, [layout.boxSpacing, layout.columns, layout.rows]);

  // The preview uses the same 96dpi coordinate system as PDF generation.
  // Keep this fixed so an X/Y value has one visible, predictable position.
  const scale = baseScale;
  const today = new Date().toISOString().split("T")[0];


  /** Extracts clientX/clientY from either a mouse or touch React event. */
  function getPointerXY(e: React.MouseEvent | React.TouchEvent): { x: number; y: number } | null {
    if ("touches" in e) {
      const touch = e.touches[0] ?? e.changedTouches[0];
      if (!touch) return null;
      return { x: touch.clientX, y: touch.clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  const handlePointerDown = useCallback(
    (target: DragTarget) => (e: React.MouseEvent | React.TouchEvent) => {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      setDragging(target);
    },
    [editable]
  );

  const handlePointerMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!editable || !dragging || !boxRef.current || !onLayoutChange) return;
      const point = getPointerXY(e);
      if (!point) return;
      // Prevent the page from scrolling while dragging an element on touch.
      if ("touches" in e) e.preventDefault();
      const rect = boxRef.current.getBoundingClientRect();
      const xPx = (point.x - rect.left) / scale;
      const yPx = (point.y - rect.top) / scale;
      const x = Math.max(0, Math.round(xPx));
      const y = Math.max(0, Math.round(yPx));

      if (dragging === "text") onLayoutChange({ textPositionX: x, textPositionY: y });
      if (dragging === "serial") onLayoutChange({ serialPositionX: x, serialPositionY: y });
      if (dragging === "date") onLayoutChange({ datePositionX: x, datePositionY: y });
      if (dragging === "customText")
        onLayoutChange({ customTextPositionX: x, customTextPositionY: y });
    },
    [editable, dragging, scale, onLayoutChange]
  );

  function handlePointerUp() {
    setDragging(null);
  }

  const elementClass = editable
    ? "absolute cursor-move touch-none whitespace-nowrap rounded leading-none hover:outline hover:outline-1 hover:outline-primary"
    : "absolute whitespace-nowrap rounded leading-none";

  return (
    <div>
      <div className="flex items-center justify-center overflow-auto rounded-lg border border-border bg-secondary/40 p-3 sm:p-6">
        <div
          ref={boxRef}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          onTouchCancel={handlePointerUp}
          className="relative select-none bg-center bg-no-repeat"
          style={{
            width: `${boxWidthPx}px`,
            height: `${boxHeightPx}px`,
            backgroundImage: layout.backgroundImageDataUrl
              ? `url(${layout.backgroundImageDataUrl})`
              : undefined,
            backgroundSize:
              layout.backgroundFit === "stretch"
                ? "100% 100%"
                : layout.backgroundFit === "cover"
                  ? "cover"
                  : "contain",
            backgroundColor: layout.backgroundImageDataUrl ? "transparent" : "white",
            border: layout.useBorder
              ? `${layout.borderWidth}px solid ${layout.borderColor}`
              : "1px solid hsl(var(--border))",
          }}
        >
          <div
            onMouseDown={handlePointerDown("text")}
            onTouchStart={handlePointerDown("text")}
            className={elementClass}
            style={{
              left: `${layout.textPositionX * scale}px`,
              top: `${layout.textPositionY * scale}px`,
              fontSize: previewFontSize(layout.textSize, scale),
              color: layout.textColor,
              fontWeight: layout.fontWeight,
              fontFamily: cssFontFamily(layout.font),
              textAlign: layout.textAlign,
              transform: anchorTransform(layout.textAlign, layout.textRotation),
              transformOrigin: anchorOrigin(layout.textAlign),
            }}
          >
            {sampleNumber || "12345678"}
          </div>

          {printOptions.useSerialNumber && (
            <div
              onMouseDown={handlePointerDown("serial")}
            onTouchStart={handlePointerDown("serial")}
              className={elementClass}
              style={{
                left: `${layout.serialPositionX * scale}px`,
                top: `${layout.serialPositionY * scale}px`,
                fontSize: previewFontSize(layout.serialNumberSize, scale),
                color: layout.serialColor,
                fontFamily: cssFontFamily(layout.font),
                transformOrigin: "left top",
              }}
            >
              {printOptions.serialStartNumber}
            </div>
          )}

          {printOptions.useDatePrinting && (
            <div
              onMouseDown={handlePointerDown("date")}
            onTouchStart={handlePointerDown("date")}
              className={elementClass}
              style={{
                left: `${layout.datePositionX * scale}px`,
                top: `${layout.datePositionY * scale}px`,
                fontSize: previewFontSize(layout.dateSize, scale),
                color: layout.dateColor,
                fontFamily: cssFontFamily(layout.font),
                transformOrigin: "left top",
              }}
            >
              {today}
            </div>
          )}

          {printOptions.useCustomText && (
            <div
              onMouseDown={handlePointerDown("customText")}
            onTouchStart={handlePointerDown("customText")}
              className={elementClass}
              style={{
                left: `${layout.customTextPositionX * scale}px`,
                top: `${layout.customTextPositionY * scale}px`,
                fontSize: previewFontSize(layout.customTextSize, scale),
                color: layout.customTextColor,
                fontFamily: cssFontFamily(layout.font),
                transformOrigin: "left top",
              }}
            >
              {printOptions.customText || "نص اختياري"}
            </div>
          )}
        </div>
      </div>
      {editable && (
        <p className="text-center text-xs text-muted-foreground">
          اسحب أي عنصر مباشرة على الكرت لتحديث موضعه تلقائيًا.
        </p>
      )}
    </div>
  );
}
