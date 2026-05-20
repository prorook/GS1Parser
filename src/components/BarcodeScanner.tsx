import { useEffect, useRef, useState, useCallback } from "react";
import { readBarcodes, type ReadResult, type ReaderOptions } from "zxing-wasm/reader";

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
  maxNumberOfSymbols: 1,
};

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const stoppedRef = useRef(false);

  const stopScanning = useCallback(() => {
    stoppedRef.current = true;
    cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
  }, []);

  const startScanning = useCallback(async () => {
    setError(null);
    setLastScan(null);
    stoppedRef.current = false;
    setIsScanning(true);

    // Wait for video element to render
    await new Promise((r) => setTimeout(r, 50));

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
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      videoEl.srcObject = stream;
      await videoEl.play();

      const ctx = canvasEl.getContext("2d", { willReadFrequently: true })!;

      const scan = async () => {
        if (stoppedRef.current) return;

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
              videoEl.srcObject = null;

              setLastScan(`${r.symbologyIdentifier}${r.text.substring(0, 60)}`);
              setIsScanning(false);
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
        className={`w-full rounded-lg bg-gray-800 ${isScanning ? "" : "hidden"}`}
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
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            📷 Scan Barcode
          </button>
        ) : (
          <button
            onClick={stopScanning}
            className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
          >
            ⏹ Stop
          </button>
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
