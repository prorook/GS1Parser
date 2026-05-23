import { useState, useCallback, useRef } from "react";
import { BarcodeScanner, type ScanResult } from "./components/BarcodeScanner";
import { ParseResults } from "./components/ParseResults";
import { parseGS1ScanData, parseGS1Manual, type ParseResult } from "./lib/gs1-parser";

export default function App() {
  const [result, setResult] = useState<ParseResult | null>(null);
  const [manualInput, setManualInput] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [parsing, setParsing] = useState(false);

  // Incremented on every scan/manual-parse request. Only the handler whose
  // id still matches the ref commits its result — older in-flight parses
  // (rapid re-scans, switching from scan to manual mid-parse) are discarded
  // so the screen always reflects the user's most recent intent.
  const requestIdRef = useRef(0);

  const handleScan = useCallback(
    async (scan: ScanResult) => {
      const myId = ++requestIdRef.current;
      setParsing(true);
      try {
        const parsed = await parseGS1ScanData(scan);
        if (requestIdRef.current !== myId) return;
        setResult(parsed);
      } catch (err) {
        console.error("Parse error:", err);
        if (requestIdRef.current !== myId) return;
        setResult({
          gs1Confidence: "unlikely",
          isCompliant: false,
          symbology: scan.format,
          symbologyIdentifier: scan.symbologyIdentifier,
          contentType: scan.contentType,
          barcodeFormat: scan.format,
          rawData: scan.text,
          originalInput: scan.scanData,
          elements: [],
          errors: [{ severity: "error", message: `Parser error: ${err instanceof Error ? err.message : String(err)}` }],
          warnings: [],
          hasGroupSeparators: scan.text.includes("\x1D"),
        });
      } finally {
        if (requestIdRef.current === myId) setParsing(false);
      }
    },
    []
  );

  const handleManualParse = useCallback(async () => {
    if (!manualInput.trim()) return;
    const myId = ++requestIdRef.current;
    setParsing(true);
    try {
      // Replace literal "<GS>" with actual GS character for testing
      const cleaned = manualInput.replace(/<GS>/gi, "\x1D");
      const parsed = await parseGS1Manual(cleaned);
      if (requestIdRef.current !== myId) return;
      setResult(parsed);
    } catch (err) {
      console.error("Parse error:", err);
      if (requestIdRef.current !== myId) return;
      setResult({
        gs1Confidence: "unlikely",
        isCompliant: false,
        symbology: "Unknown",
        symbologyIdentifier: "",
        contentType: "Unknown",
        barcodeFormat: "Manual Input",
        rawData: manualInput,
        originalInput: manualInput,
        elements: [],
        errors: [{ severity: "error", message: `Parser error: ${err instanceof Error ? err.message : String(err)}` }],
        warnings: [],
        hasGroupSeparators: manualInput.includes("\x1D"),
      });
    } finally {
      if (requestIdRef.current === myId) setParsing(false);
    }
  }, [manualInput]);

  const handleReset = useCallback(() => {
    setResult(null);
    setManualInput("");
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-2 sm:p-4">
      <div className="w-full max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <header className="text-center space-y-1">
          <h1 className="text-2xl font-bold">GS1 Barcode Parser</h1>
          <p className="text-gray-400 text-sm">
            Scan a barcode to validate GS1 compliance
          </p>
        </header>

        {/* Scanner or Results */}
        {!result ? (
          <div className="space-y-4">
            {parsing && (
              <div className="text-center text-gray-400 text-sm py-4">
                Parsing barcode data...
              </div>
            )}
            <BarcodeScanner onScan={handleScan} />

            {/* Manual Input Toggle */}
            <div className="text-center">
              <button
                onClick={() => setShowManual(!showManual)}
                className="text-sm text-gray-400 hover:text-gray-200 underline"
              >
                {showManual ? "Hide manual input" : "Or enter barcode data manually"}
              </button>
            </div>

            {showManual && (
              <div className="space-y-2">
                <label htmlFor="manual-input" className="sr-only">
                  Barcode data
                </label>
                <textarea
                  id="manual-input"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  placeholder="Paste barcode data here. Use <GS> for group separator characters."
                  className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg text-sm font-mono text-white placeholder-gray-500 resize-none"
                  rows={3}
                />
                <button
                  onClick={handleManualParse}
                  disabled={!manualInput.trim() || parsing}
                  className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg transition-colors"
                >
                  {parsing ? "Parsing..." : "Parse"}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ParseResults result={result} />
            <button
              onClick={handleReset}
              className="w-full px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors"
            >
              Scan Another
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
