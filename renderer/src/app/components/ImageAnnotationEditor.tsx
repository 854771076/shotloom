import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import ScreenshotsContext from "../../../../node_modules/react-screenshots/lib/Screenshots/ScreenshotsContext.js";
import ScreenshotsCanvas from "../../../../node_modules/react-screenshots/lib/Screenshots/ScreenshotsCanvas/index.js";
import ScreenshotsOperations from "../../../../node_modules/react-screenshots/lib/Screenshots/ScreenshotsOperations/index.js";
import zhCN from "../../../../node_modules/react-screenshots/lib/Screenshots/zh_CN.js";

export type ImageAnnotation = { id: string; kind: "rect" | "ellipse" | "arrow" | "line" | "pen" | "text" | "annotation" | "mosaic"; points: Array<{ x: number; y: number }>; text?: string; color?: string; strokeWidth?: number };
export type ImageAnnotationSave = { blob: Blob; bounds: { x: number; y: number; width: number; height: number } };

type ContextValue = { store: any; dispatcher: any };

/** Uses react-screenshots' editing operations on an image-node canvas.
 * Its screenshot background/crop flow is intentionally not rendered here. */
export function ImageAnnotationEditor({ imageUrl, imageWidth, imageHeight, semanticZoom = 1, root, anchorRef, onCancel, onSave }: { imageUrl: string; imageWidth: number; imageHeight: number; annotations?: ImageAnnotation[]; semanticZoom?: number; root: HTMLElement | null; anchorRef: RefObject<HTMLDivElement | null>; onCancel: () => void; onSave: (result: ImageAnnotationSave) => void }) {
  const canvasContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const emitterRef = useRef<Record<string, unknown>>({});
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [history, setHistory] = useState({ index: -1, stack: [] as any[] });
  const [operation, setOperation] = useState<string | undefined>(undefined);
  const [screenRect, setScreenRect] = useState({ left: 0, top: 0, width: imageWidth, height: imageHeight });
  useEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current;
      const host = root;
      if (!anchor || !host) return;
      const anchorRect = anchor.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      setScreenRect({
        left: anchorRect.left - hostRect.left,
        top: anchorRect.top - hostRect.top,
        width: anchorRect.width || imageWidth,
        height: anchorRect.height || imageHeight,
      });
    };
    updatePosition();
    let frame = 0;
    const syncFrame = () => {
      updatePosition();
      frame = requestAnimationFrame(syncFrame);
    };
    frame = requestAnimationFrame(syncFrame);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updatePosition) : null;
    if (anchorRef.current) observer?.observe(anchorRef.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, imageHeight, imageWidth, root, semanticZoom]);
  useEffect(() => {
    document.body.classList.add("annotation-editor-open");
    const finishTextEntry = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.target instanceof HTMLTextAreaElement) || !event.target.classList.contains("screenshots-textarea")) return;
      event.preventDefault();
      event.target.blur();
    };
    document.addEventListener("keydown", finishTextEntry, true);
    let frame = 0;
    const syncOptionPosition = () => {
      const selected = Array.from(document.querySelectorAll<HTMLElement>(
        ".canvas-image-annotation-editor .screenshots-button-checked",
      )).at(-1);
      const option = Array.from(document.querySelectorAll<HTMLElement>(
        "body.annotation-editor-open .screenshots-option",
      )).find((item) => item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0);
      if (selected && option) {
        const buttonRect = selected.getBoundingClientRect();
        const optionRect = option.getBoundingClientRect();
        const optionWidth = optionRect.width || option.scrollWidth;
        const optionHeight = optionRect.height || option.scrollHeight;
        if (!optionWidth || !optionHeight) {
          frame = requestAnimationFrame(syncOptionPosition);
          return;
        }
        const left = Math.max(8, Math.min(
          window.innerWidth - optionWidth - 8,
          buttonRect.left + buttonRect.width / 2 - optionWidth / 2,
        ));
        const above = buttonRect.top - optionHeight - 12;
        const top = above >= 8 ? above : buttonRect.bottom + 12;
        option.style.setProperty("left", `${left}px`, "important");
        option.style.setProperty("top", `${top}px`, "important");
        option.style.setProperty("visibility", "visible", "important");
      }
      frame = requestAnimationFrame(syncOptionPosition);
    };
    frame = requestAnimationFrame(syncOptionPosition);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", finishTextEntry, true);
      document.body.classList.remove("annotation-editor-open");
    };
  }, []);
  const width = screenRect.width;
  const height = screenRect.height;
  useEffect(() => {
    const next = new Image();
    next.onload = () => setImage(next);
    next.src = imageUrl;
    return () => { next.onload = null; };
  }, [imageUrl]);
  const store = useMemo(() => ({ url: imageUrl, image, width, height, lang: { ...zhCN, operation_text_title: "标注", operation_mosaic_title: "马赛克", operation_ellipse_title: "圆形", operation_rectangle_title: "矩形", operation_cancel_title: "关闭", operation_ok_title: "完成" }, emitterRef, canvasContextRef, history, bounds: { x: 0, y: 0, width, height }, cursor: operation ? "crosshair" : "default", operation }), [imageUrl, image, width, height, history, operation]);
  const dispatcher = useMemo(() => ({ call: (name: string, ...args: unknown[]) => { if (name === "onCancel") onCancel(); if (name === "onSave" || name === "onOk") onSave({ blob: args[0] as Blob, bounds: args[1] as ImageAnnotationSave["bounds"] }); }, setHistory, setBounds: () => undefined, setCursor: () => undefined, setOperation }), [onCancel, onSave]);
  const context = useMemo<ContextValue>(() => ({ store, dispatcher }), [store, dispatcher]);
  if (!root) return null;
  return createPortal(<div className="canvas-image-annotation-editor nodrag nopan nowheel" style={{ left: screenRect.left, top: screenRect.top, width, height, "--canvas-annotation-toolbar-scale": "1" } as CSSProperties} onPointerDown={(event) => event.stopPropagation()}>
    <ScreenshotsContext.Provider value={context}>
      {image && <ScreenshotsCanvas ref={canvasContextRef} />}
      {image && <ScreenshotsOperations />}
    </ScreenshotsContext.Provider>
  </div>, root);
}

export function ImageAnnotationOverlay({ annotations }: { annotations: ImageAnnotation[] }) { return <>{annotations.length ? null : null}</>; }
