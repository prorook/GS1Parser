import { useEffect, useRef, useState, useCallback } from "react";
import { prepareZXingModule, readBarcodes, type ReadResult, type ReaderOptions } from "zxing-wasm/reader";
import zxingReaderWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// Bundle the WASM with the app so we never fetch from jsDelivr at runtime.
// Without this override, zxing-wasm's default locateFile points at the CDN.
prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? zxingReaderWasmUrl : prefix + path) } });

export interface ScanResult {
  /** Full scan data string: symbologyIdentifier + text (ready for gs1encoder.scanData) */
  scanData: string;
  /** AIM symbology identifier e.g. "]C1", "]d2", "]Q3", "]e0" */
  symbologyIdentifier: string;
  /** Decoded text content (without AIM prefix) */
  text: string;
  /** Content type as determined by zxing-cpp: "GS1", "Text", "Binary", etc. */
  contentType: string;
  /** Barcode format e.g. "Code128", "QRCode", "DataMatrix" */
  format: string;
}

interface BarcodeScannerProps {
  onScan: (result: ScanResult) => void;
}

const READER_OPTIONS: ReaderOptions = {
  formats: ["Code128", "QRCode", "DataMatrix", "DataBar", "EAN13", "EAN8", "ITF"],
  tryHarder: true,
  tryRotate: true,
  // Long dense GS1-128 codes need full bar resolution. Internal downscaling
  // smears narrow bars and tanks recognition on labels with 5–6 AIs.
  tryDownscale: false,
  minLineCount: 1,
  maxNumberOfSymbols: 1,
};

// Region-of-interest geometry.
//
// Two ROI computations from the same percentages:
//
// - `computeScanRoi` runs in the scan loop on (sourceW, sourceH) and uses
//   min(sourceW, sourceH) as its base. Source dimensions don't change with
//   phone orientation (the camera sensor is fixed), so the scanned region
//   is a stable fraction of the source frame.
//
// - `computeOverlayRoi` runs in the aim overlay on (containerW, containerH)
//   but uses viewport `vmin` (phone's physical narrow side) as its base.
//   vmin is the same in portrait and landscape, so the visible band stays
//   the same absolute size when you rotate the phone — using min of the
//   container would change because the container itself reshapes.
//
// 1D mode: horizontal strip = base × pct tall, full container width.
// 2D mode: centered square = base × pct on a side.
// Full mode: no ROI — scan the whole frame. For oddball codes that don't
// fit either preset (e.g. GS1 DataBar Stacked, which is wider than 1D's
// strip and taller than 2D's square).
const ROI_1D_BASE_PCT = 0.40;
const ROI_2D_BASE_PCT = 0.65;

type RoiMode = "1d" | "2d" | "full";
type RoiRect = { x: number; y: number; w: number; h: number };

const MODE_CYCLE: RoiMode[] = ["1d", "2d", "full"];
const MODE_LABEL: Record<RoiMode, string> = { "1d": "1D", "2d": "2D", "full": "Full" };
const MODE_DESCRIPTION: Record<RoiMode, string> = {
  "1d": "1D barcode (horizontal strip)",
  "2d": "2D barcode (centered square)",
  "full": "Full frame (no aim region)",
};

function nextMode(mode: RoiMode): RoiMode {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]!;
}

// Persist the ROI mode so it survives "Scan Another" (which unmounts the
// scanner) and full page reloads.
const ROI_MODE_STORAGE_KEY = "gs1parser.roiMode";

function loadStoredRoiMode(): RoiMode {
  if (typeof window === "undefined") return "1d";
  try {
    const stored = window.localStorage.getItem(ROI_MODE_STORAGE_KEY);
    if (stored === "1d" || stored === "2d" || stored === "full") return stored;
  } catch { /* localStorage may be disabled; fall through */ }
  return "1d";
}

function saveRoiMode(mode: RoiMode): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ROI_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
}

function roiFromBase(mode: RoiMode, w: number, h: number, base: number): RoiRect {
  if (mode === "full") {
    return { x: 0, y: 0, w, h };
  }
  if (mode === "1d") {
    const bh = Math.min(h, Math.floor(base * ROI_1D_BASE_PCT));
    return { x: 0, y: Math.floor((h - bh) / 2), w, h: bh };
  }
  const side = Math.min(w, h, Math.floor(base * ROI_2D_BASE_PCT));
  return {
    x: Math.floor((w - side) / 2),
    y: Math.floor((h - side) / 2),
    w: side,
    h: side,
  };
}

function computeScanRoi(mode: RoiMode, sourceW: number, sourceH: number): RoiRect {
  return roiFromBase(mode, sourceW, sourceH, Math.min(sourceW, sourceH));
}

function computeOverlayRoi(mode: RoiMode, containerW: number, containerH: number): RoiRect {
  // Fall back to the smaller container dim if vmin is unavailable (SSR / tests).
  const vmin = typeof window === "undefined"
    ? Math.min(containerW, containerH)
    : Math.min(window.innerWidth, window.innerHeight);
  return roiFromBase(mode, containerW, containerH, vmin);
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState<Array<{ id: number; text: string }>>([]);
  const scanLogIdRef = useRef(0);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [roiMode, setRoiMode] = useState<RoiMode>(loadStoredRoiMode);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const rafRef = useRef<number>(0);
  // Per-session counter, incremented on every start/stop/unmount. Each scan
  // loop captures its own session id at startup; an in-flight readBarcodes
  // that resolves AFTER its session was ended (the user clicked Stop, or
  // started a new scan) sees sessionIdRef.current !== mySession and bails
  // — it can't deliver a stale scan to a fresh session.
  const sessionIdRef = useRef(0);
  // Mirror roiMode into a ref so the scan loop reads the current value each
  // tick without having to be torn down and recreated on toggle.
  const roiModeRef = useRef<RoiMode>(roiMode);

  const stopScanning = useCallback(() => {
    sessionIdRef.current++;
    cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    videoTrackRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
    setTorchSupported(false);
    setTorchOn(false);
  }, []);

  const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so the same file can be re-selected.
    e.target.value = "";
    if (!file) return;

    setError(null);
    setLastScan(null);

    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load image"));
      });

      // Cap dimensions to avoid memory issues on low-end devices.
      const MAX_DIM = 4096;
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      const canvas = canvasRef.current;
      if (!canvas) { setError("Canvas not available"); return; }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) { setError("2D context unavailable"); return; }
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);

      const results = await readBarcodes(imageData, READER_OPTIONS);
      const first = results[0];
      if (!first || !first.isValid) {
        setError("No barcode detected in image. Try a clearer photo or different angle.");
        return;
      }

      const rawText = new TextDecoder("iso-8859-1").decode(first.bytes);
      const scanResult: ScanResult = {
        scanData: first.symbologyIdentifier + rawText,
        symbologyIdentifier: first.symbologyIdentifier,
        text: rawText,
        contentType: first.contentType,
        format: first.format,
      };

      const timestamp = new Date().toLocaleTimeString();
      const logEntry = `[${timestamp}] ${first.format} | SI=${first.symbologyIdentifier} | CT=${first.contentType} | text=${first.text.substring(0, 50)}${first.text.length > 50 ? "..." : ""}`;
      const entry = { id: ++scanLogIdRef.current, text: logEntry };
      setScanLog((prev) => [entry, ...prev].slice(0, 20));

      setLastScan(`${first.symbologyIdentifier}${first.text.substring(0, 60)}`);
      onScan(scanResult);
    } catch (err) {
      setError(`Image error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [onScan]);

  const toggleRoiMode = useCallback(() => {
    setRoiMode((prev) => nextMode(prev));
  }, []);

  // Sync roiModeRef and persist on every change to roiMode — regardless of
  // which call site triggered the change. Keeps the scan-loop ref consistent
  // with state and removes the side effects from the setState updater (React
  // calls updaters twice in StrictMode and expects them to be pure).
  useEffect(() => {
    roiModeRef.current = roiMode;
    saveRoiMode(roiMode);
  }, [roiMode]);

  const toggleTorch = useCallback(async () => {
    const track = videoTrackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` isn't in the standard MediaTrackConstraintSet type but is
      // supported on most mobile Chrome/Edge builds.
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch (err) {
      setError(`Torch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [torchOn]);

  const startScanning = useCallback(async () => {
    setError(null);
    setLastScan(null);
    const mySession = ++sessionIdRef.current;
    setIsScanning(true);

    // <video> is always mounted (just `hidden`), but React still needs a tick
    // to flip the class before we touch the ref. One frame is enough.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    // The user could have hit Stop during the RAF wait — bail before we touch
    // the camera so we don't acquire a stream the user no longer wants.
    if (sessionIdRef.current !== mySession) return;

    const videoEl = videoRef.current;
    const canvasEl = canvasRef.current;
    if (!videoEl || !canvasEl) {
      setError("Video/canvas element not available");
      setIsScanning(false);
      return;
    }

    // getUserMedia is only exposed in secure contexts (https://, localhost).
    // On http:// `navigator.mediaDevices` is undefined and the bare property
    // access below would throw a generic TypeError — surface a clear message.
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      setError("Camera access requires a secure context (HTTPS or localhost).");
      setIsScanning(false);
      sessionIdRef.current++;
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          // Long dense GS1-128 vendor labels need every bar to land on enough
          // pixels to be distinguishable. Browser picks the best the camera
          // can actually deliver.
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          focusMode: { ideal: "continuous" },
        } as MediaTrackConstraints,
        audio: false,
      });
      // The user may have hit Stop while getUserMedia was in flight — if so,
      // release the stream we just acquired instead of leaving it live.
      if (sessionIdRef.current !== mySession) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      videoEl.srcObject = stream;
      await videoEl.play();

      // Probe for torch support on the chosen video track.
      const track = stream.getVideoTracks()[0] ?? null;
      videoTrackRef.current = track;
      if (track && typeof track.getCapabilities === "function") {
        const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
        setTorchSupported(caps.torch === true);
      }

      const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("2D canvas context unavailable");
      let frameSkip = 0;

      const scan = async () => {
        if (sessionIdRef.current !== mySession) return;

        // Process every 2nd RAF. At 4K, one getImageData + readBarcodes cycle
        // is already ~150–300 ms, so this mostly keeps us from queueing reads
        // on slow devices rather than reducing real throughput.
        frameSkip = (frameSkip + 1) % 2;
        if (frameSkip !== 0) {
          rafRef.current = requestAnimationFrame(scan);
          return;
        }

        // Grab only the ROI rectangle as ImageData. Painting just the slice
        // (rather than the whole frame and then sampling) keeps both the
        // canvas size and the JS→WASM transfer small. ROI mode is read
        // from a ref each tick so toggling 1D ↔ 2D takes effect immediately.
        const { videoWidth, videoHeight } = videoEl;
        if (videoWidth > 0 && videoHeight > 0) {
          const roi = computeScanRoi(roiModeRef.current, videoWidth, videoHeight);
          canvasEl.width = roi.w;
          canvasEl.height = roi.h;
          ctx.drawImage(
            videoEl,
            roi.x, roi.y, roi.w, roi.h, // source rect (ROI slice of frame)
            0,     0,     roi.w, roi.h, // dest rect (whole canvas)
          );
          const imageData = ctx.getImageData(0, 0, roi.w, roi.h);

          try {
            const results: ReadResult[] = await readBarcodes(imageData, READER_OPTIONS);
            const first = results[0];

            if (first && first.isValid && sessionIdRef.current === mySession) {
              // Bump the session id so any other in-flight readBarcodes from
              // this session that resolves after us short-circuits at its
              // session check above instead of double-firing onScan.
              sessionIdRef.current++;
              const r = first;

              // Decode raw bytes 1:1 to codepoints using ISO-8859-1 so every
              // byte (0x00–0xFF) round-trips losslessly. The default UTF-8
              // decoder replaces invalid sequences with U+FFFD, which corrupts
              // Latin-1 / byte-mode DataMatrix / QR payloads before they reach
              // gs1encoder. Control chars like \x1D (GS) are ASCII and pass
              // through either way.
              const rawText = new TextDecoder("iso-8859-1").decode(r.bytes);

              const scanResult: ScanResult = {
                scanData: r.symbologyIdentifier + rawText,
                symbologyIdentifier: r.symbologyIdentifier,
                text: rawText,
                contentType: r.contentType,
                format: r.format,
              };

              // Log the scan (use r.text for readable display)
              const timestamp = new Date().toLocaleTimeString();
              const logEntry = `[${timestamp}] ${r.format} | SI=${r.symbologyIdentifier} | CT=${r.contentType} | text=${r.text.substring(0, 50)}${r.text.length > 50 ? "..." : ""}`;
              const entry = { id: ++scanLogIdRef.current, text: logEntry };
              setScanLog((prev) => [entry, ...prev].slice(0, 20));

              // Stop camera
              stream.getTracks().forEach((t) => t.stop());
              streamRef.current = null;
              videoTrackRef.current = null;
              videoEl.srcObject = null;

              setLastScan(`${r.symbologyIdentifier}${r.text.substring(0, 60)}`);
              setIsScanning(false);
              setTorchSupported(false);
              setTorchOn(false);
              onScan(scanResult);
              return;
            }
          } catch {
            // readBarcodes can throw on invalid frame data
          }
        }
        rafRef.current = requestAnimationFrame(scan);
      };

      rafRef.current = requestAnimationFrame(scan);
    } catch (err) {
      // play() can reject (NotAllowedError, AbortError), getContext('2d') can
      // return null, etc. Whatever blew up, release the stream we may have
      // already acquired — otherwise the camera LED stays on until the page
      // is closed.
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      videoTrackRef.current = null;
      if (videoEl) videoEl.srcObject = null;
      sessionIdRef.current++;
      const message = err instanceof Error ? err.message : String(err);
      setError(`Camera error: ${message}`);
      setIsScanning(false);
      setTorchSupported(false);
      setTorchOn(false);
    }
  }, [onScan]);

  useEffect(() => {
    return () => {
      sessionIdRef.current++;
      cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div className="relative w-full overflow-hidden rounded-lg">
        <video
          ref={videoRef}
          className={`w-full max-h-[70dvh] object-cover bg-gray-800 ${isScanning ? "" : "hidden"}`}
          playsInline
          muted
        />
        {isScanning && <RoiOverlay mode={roiMode} />}
      </div>
      <canvas ref={canvasRef} className="hidden" />

      {error && (
        <div className="text-red-400 text-sm px-4 py-2 bg-red-900/30 rounded">
          {error}
        </div>
      )}

      {lastScan && !isScanning && (
        <div className="text-green-400 text-xs px-4 py-2 bg-green-900/30 rounded font-mono break-all">
          Scanned: {lastScan}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileImport}
        className="hidden"
      />

      <div className="flex gap-3">
        {!isScanning ? (
          <>
            <button
              onClick={startScanning}
              aria-label="Scan barcode"
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
            >
              <span aria-hidden="true">📷 </span>Scan Barcode
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              aria-label="Import barcode image"
              className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors"
            >
              <span aria-hidden="true">📁 </span>Import Image
            </button>
          </>
        ) : (
          <>
            <button
              onClick={stopScanning}
              aria-label="Stop scanning"
              className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
            >
              <span aria-hidden="true">⏹ </span>Stop
            </button>
            {torchSupported && (
              <button
                onClick={toggleTorch}
                aria-label={torchOn ? "Turn flashlight off" : "Turn flashlight on"}
                aria-pressed={torchOn}
                className={`px-6 py-3 font-medium rounded-lg transition-colors ${torchOn ? "bg-yellow-500 hover:bg-yellow-600 text-gray-900" : "bg-gray-700 hover:bg-gray-600 text-white"}`}
              >
                <span aria-hidden="true">🔦 </span>{torchOn ? "On" : "Off"}
              </button>
            )}
            <button
              onClick={toggleRoiMode}
              aria-label={`Scan mode: ${MODE_DESCRIPTION[roiMode]}. Tap to switch to ${MODE_LABEL[nextMode(roiMode)]}.`}
              className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors"
            >
              {MODE_LABEL[roiMode]}
            </button>
          </>
        )}
      </div>

      <p className="text-gray-500 text-xs text-center">
        Supports: Code 128 / GS1-128, QR Code, DataMatrix, GS1 DataBar, EAN/UPC
        <br />
        <span className="text-gray-600">Powered by ZXing-C++ WASM — reports AIM symbology identifiers</span>
      </p>

      {/* Scan Log */}
      {scanLog.length > 0 && (
        <details className="w-full text-xs">
          <summary className="text-gray-500 cursor-pointer hover:text-gray-300">
            Scan history ({scanLog.length})
          </summary>
          <div className="mt-2 p-2 bg-gray-800 rounded max-h-40 overflow-y-auto space-y-1">
            {scanLog.map((entry) => (
              <div key={entry.id} className="font-mono text-gray-400 break-all">{entry.text}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// Aim overlay positioned over the video element. Measures the displayed
// container so the 2D square sizes off the smaller dimension (which pure
// CSS can't constrain cleanly), and so 1D height looks the same in
// portrait and landscape. Uses `computeOverlayRoi` so the visible band
// lines up with what readBarcodes actually sees.
//
// In "full" mode the whole frame is scanned, so there's no aim band to
// draw — render nothing.
//
// The container has `overflow-hidden`, so the huge box-shadow safely
// dims everything outside the aim rect.
function RoiOverlay({ mode }: { mode: RoiMode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<RoiRect | null>(null);

  useEffect(() => {
    if (mode === "full") {
      setBox(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setBox(computeOverlayRoi(mode, w, h));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Orientation change resizes the viewport (so vmin changes), but the
    // overlay container's size may not — listen explicitly so we recompute.
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [mode]);

  if (mode === "full") return null;

  return (
    <div ref={ref} className="absolute inset-0 pointer-events-none">
      {box && (
        <>
          <div
            className="absolute border-2 border-blue-400/80 rounded-sm"
            style={{
              left: box.x,
              top: box.y,
              width: box.w,
              height: box.h,
              boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
            }}
          />
          {mode === "1d" && (
            <div
              className="absolute border-t border-red-500/80"
              style={{
                left: box.x,
                top: box.y + Math.floor(box.h / 2),
                width: box.w,
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
