import type { ParseResult, Severity } from "../lib/gs1-parser";

interface ParseResultsProps {
  result: ParseResult;
}

export function ParseResults({ result }: ParseResultsProps) {
  const { gs1Confidence, isCompliant, symbology, symbologyIdentifier, contentType, barcodeFormat, elements, errors, warnings, rawData } = result;

  return (
    <div className="w-full max-w-lg mx-auto space-y-4">
      {/* Header / Status */}
      <div className={`p-4 rounded-lg border ${getStatusStyles(isCompliant, gs1Confidence)}`}>
        <div className="flex items-center gap-2 text-lg font-semibold">
          <span aria-hidden="true">{getStatusIcon(isCompliant, gs1Confidence)}</span>
          <span>{getStatusText(isCompliant, gs1Confidence)}</span>
        </div>
        <p className="text-sm mt-1 opacity-80">Symbology: {symbology}</p>
        {getStatusSubtext(isCompliant, gs1Confidence) && (
          <p className="text-sm mt-2 opacity-90">{getStatusSubtext(isCompliant, gs1Confidence)}</p>
        )}
      </div>

      {/* Scan Metadata */}
      {symbologyIdentifier && (
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-3 space-y-1">
          <h3 className="text-gray-400 font-semibold text-xs uppercase tracking-wide mb-2">Scan Details</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-gray-400">AIM Symbology ID:</span>
            <span className="font-mono text-cyan-300">{symbologyIdentifier}</span>
            <span className="text-gray-400">Content Type:</span>
            <span className="font-mono text-white">{contentType}</span>
            <span className="text-gray-400">Barcode Format:</span>
            <span className="font-mono text-white">{barcodeFormat}</span>
          </div>
        </div>
      )}

      {/* Global Errors */}
      {errors.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-red-400 font-semibold text-sm uppercase tracking-wide">Errors</h3>
          {errors.map((msg, i) => (
            <MessageCard key={i} severity={msg.severity} message={msg.message} />
          ))}
        </div>
      )}

      {/* Global Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-yellow-400 font-semibold text-sm uppercase tracking-wide">Warnings</h3>
          {warnings.map((msg, i) => (
            <MessageCard key={i} severity={msg.severity} message={msg.message} />
          ))}
        </div>
      )}

      {/* Parsed Elements Table */}
      {elements.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-gray-300 font-semibold text-sm uppercase tracking-wide">
            Parsed Elements
          </h3>
          <div className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="text-left px-3 py-2">AI</th>
                  <th className="text-left px-3 py-2">Label</th>
                  <th className="text-left px-3 py-2">Value</th>
                  <th scope="col" className="text-left px-3 py-2 w-8">
                    <span className="sr-only">Status</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {elements.map((el, i) => (
                  <tr
                    key={i}
                    className={`border-b border-gray-700/50 ${el.errors.length > 0 ? "bg-red-900/20" : ""}`}
                  >
                    <td className="px-3 py-2 font-mono text-blue-300">({el.ai})</td>
                    <td className="px-3 py-2 text-gray-300">{el.label}</td>
                    <td className="px-3 py-2 font-mono text-white">{el.displayValue}</td>
                    <td className="px-3 py-2">
                      <span role="img" aria-label={el.errors.length > 0 ? "Invalid" : "Valid"}>
                        {el.errors.length > 0 ? "❌" : "✅"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Element-level errors */}
          {elements
            .filter((el) => el.errors.length > 0)
            .map((el, i) => (
              <div key={i} className="text-sm">
                {el.errors.map((err, j) => (
                  <MessageCard
                    key={j}
                    severity={err.severity}
                    message={`AI (${el.ai}) ${el.label}: ${err.message}`}
                  />
                ))}
              </div>
            ))}
        </div>
      )}

      {/* Raw Data & Human Readable */}
      <div className="space-y-2">
        <details className="text-sm" open={elements.length === 0}>
          <summary className="text-gray-500 cursor-pointer hover:text-gray-300">
            Raw barcode data
          </summary>
          <pre className="mt-2 p-3 bg-gray-800 rounded text-xs font-mono text-gray-400 overflow-x-auto whitespace-pre-wrap break-all">
            {rawData.replace(/\x1D/g, "<GS>")}
          </pre>
        </details>

        {elements.length > 0 && (
          <details className="text-sm">
            <summary className="text-gray-500 cursor-pointer hover:text-gray-300">
              Human readable (HRI)
            </summary>
            <pre className="mt-2 p-3 bg-gray-800 rounded text-xs font-mono text-green-300 overflow-x-auto whitespace-pre-wrap break-all">
              {elements.map((el) => `(${el.ai}) ${el.displayValue}`).join("\n")}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function MessageCard({ severity, message }: { severity: Severity; message: string }) {
  const styles = {
    error: "bg-red-900/30 border-red-700 text-red-300",
    warning: "bg-yellow-900/30 border-yellow-700 text-yellow-300",
    info: "bg-blue-900/30 border-blue-700 text-blue-300",
  };
  const icons = { error: "❌", warning: "⚠️", info: "ℹ️" };
  const role = severity === "error" ? "alert" : "status";

  return (
    <div role={role} className={`px-3 py-2 rounded border text-sm ${styles[severity]}`}>
      <span role="img" aria-label={severity}>{icons[severity]}</span> {message}
    </div>
  );
}

function getStatusStyles(isCompliant: boolean, confidence: string): string {
  if (isCompliant) return "bg-green-900/30 border-green-600 text-green-300";
  if (confidence === "unlikely") return "bg-gray-800/50 border-gray-600 text-gray-300";
  if (confidence === "likely") return "bg-orange-900/30 border-orange-600 text-orange-300";
  return "bg-yellow-900/30 border-yellow-600 text-yellow-300";
}

function getStatusIcon(isCompliant: boolean, confidence: string): string {
  if (isCompliant) return "✅";
  if (confidence === "unlikely") return "📦";
  if (confidence === "likely") return "⚠️";
  return "❌";
}

function getStatusText(isCompliant: boolean, confidence: string): string {
  if (isCompliant) return "Valid GS1 Barcode";
  if (confidence === "unlikely") return "Not a GS1 Barcode";
  if (confidence === "likely") return "GS1 Data in Non-GS1 Barcode";
  return "GS1 Barcode — Non-Compliant";
}

function getStatusSubtext(isCompliant: boolean, confidence: string): string | null {
  if (isCompliant) return "FNC1 confirmed. Data compliant with GS1 standards.";
  if (confidence === "unlikely") return "No GS1 Application Identifiers detected.";
  if (confidence === "likely") return "Contains valid GS1 AI data, but barcode is NOT encoded as GS1-128. Vendor must add FNC1 to comply.";
  return null;
}
