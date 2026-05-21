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

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState<string[]>([]);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const rafRef = useRef<number>(0);
  const stoppedRef = useRef(false);

  const stopScanning = useCallback(() => {
    stoppedRef.current = true;
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
    stoppedRef.current = false;
    setIsScanning(true);

    // <video> is always mounted (just `hidden`), but React still needs a tick
    // to flip the class before we touch the ref. One frame is enough.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const videoEl = videoRef.current;
    const canvasEl = canvasRef.current;
    if (!videoEl || !canvasEl) {
      setError("Video/canvas element not available");
      setIsScanning(false);
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

      const ctx = canvasEl.getContext("2d", { willReadFrequently: true })!;
      let frameSkip = 0;

      const scan = async () => {
        if (stoppedRef.current) return;

        // Process every 2nd RAF. At 4K, one getImageData + readBarcodes cycle
        // is already ~150–300 ms, so this mostly keeps us from queueing reads
        // on slow devices rather than reducing real throughput.
        frameSkip = (frameSkip + 1) % 2;
        if (frameSkip !== 0) {
          rafRef.current = requestAnimationFrame(scan);
          return;
        }

        // Grab frame as ImageData
        const { videoWidth, videoHeight } = videoEl;
        if (videoWidth > 0 && videoHeight > 0) {
          canvasEl.width = videoWidth;
          canvasEl.height = videoHeight;
          ctx.drawImage(videoEl, 0, 0);
          const imageData = ctx.getImageData(0, 0, videoWidth, videoHeight);

          try {
            const results: ReadResult[] = await readBarcodes(imageData, READER_OPTIONS);
            const first = results[0];

            if (first && first.isValid && !stoppedRef.current) {
              stoppedRef.current = true;
              const r = first;

              // Decode raw bytes to string, preserving control chars like \x1D (GS)
              const rawText = new TextDecoder().decode(r.bytes);

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
              setScanLog((prev) => [logEntry, ...prev].slice(0, 20));

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
      const message = err instanceof Error ? err.message : String(err);
      setError(`Camera error: ${message}`);
      setIsScanning(false);
    }
  }, [onScan]);

  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <video
        ref={videoRef}
        className={`w-full max-h-[70dvh] object-cover rounded-lg bg-gray-800 ${isScanning ? "" : "hidden"}`}
        playsInline
        muted
      />
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

      <div className="flex gap-3">
        {!isScanning ? (
          <button
            onClick={startScanning}
            aria-label="Scan barcode"
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            <span aria-hidden="true">📷 </span>Scan Barcode
          </button>
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
            {scanLog.map((entry, i) => (
              <div key={i} className="font-mono text-gray-400 break-all">{entry}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
