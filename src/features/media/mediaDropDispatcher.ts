import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type DropPosition = { x: number; y: number };

const dropZones = new Map<HTMLElement, (paths: string[]) => void>();
let stopDropListener: (() => void) | undefined;
let startingDropListener = false;

function startDropListener() {
  if (startingDropListener || stopDropListener || typeof document === "undefined") return;
  startingDropListener = true;
  void getCurrentWebviewWindow()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        dispatchMediaDrop(event.payload.position, event.payload.paths);
      }
    })
    .then((stop) => {
      startingDropListener = false;
      if (dropZones.size) stopDropListener = stop;
      else stop();
    })
    .catch(() => {
      startingDropListener = false;
    });
}

export function registerMediaDropZone(element: HTMLElement, onDrop: (paths: string[]) => void) {
  dropZones.set(element, onDrop);
  startDropListener();
  return () => {
    dropZones.delete(element);
    if (!dropZones.size && stopDropListener) {
      stopDropListener();
      stopDropListener = undefined;
    }
  };
}

export function dispatchMediaDrop(position: DropPosition, paths: string[]) {
  // Tauri reports a PhysicalPosition; DOM hit testing uses CSS pixels.
  const scaleFactor = window.devicePixelRatio || 1;
  const target = document.elementFromPoint(position.x / scaleFactor, position.y / scaleFactor);
  const zone = target?.closest<HTMLElement>("[data-media-drop-zone]");
  if (zone) dropZones.get(zone)?.(paths);
}
