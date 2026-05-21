import { GS1encoder, GS1encoderParameterException, GS1encoderScanDataException } from "gs1encoder";
import type { ScanResult } from "../components/BarcodeScanner";

export type BarcodeFormat = "CODE_128" | "DATA_MATRIX" | "QR_CODE" | "UNKNOWN";

export type GS1Confidence = "confirmed" | "likely" | "unlikely";

export type Severity = "error" | "warning" | "info";

export interface ParsedElement {
  ai: string;
  label: string;
  description: string;
  rawValue: string;
  displayValue: string;
  errors: ValidationMessage[];
  definition: null;
}

export interface ValidationMessage {
  severity: Severity;
  message: string;
}

export interface ParseResult {
  /** Whether this is confirmed, likely, or unlikely to be a GS1 barcode */
  gs1Confidence: GS1Confidence;
  /** Overall compliance status */
  isCompliant: boolean;
  /** Detected symbology */
  symbology: string;
  /** AIM symbology identifier (e.g. "]C1", "]d2", "]Q3") */
  symbologyIdentifier: string;
  /** Content type as reported by scanner (e.g. "GS1", "Text") */
  contentType: string;
  /** Barcode format (e.g. "Code128", "QRCode", "DataMatrix") */
  barcodeFormat: string;
  /** The raw input (after symbology ID stripped) */
  rawData: string;
  /** Original input including symbology ID */
  originalInput: string;
  /** Parsed AI elements */
  elements: ParsedElement[];
  /** Global errors (not tied to a specific element) */
  errors: ValidationMessage[];
  /** Global warnings */
  warnings: ValidationMessage[];
  /** Whether GS (FNC1) separators were found in the data */
  hasGroupSeparators: boolean;
}

// Lazy singleton gs1encoder instance
let encoderPromise: Promise<GS1encoder> | null = null;

function getEncoder(): Promise<GS1encoder> {
  if (!encoderPromise) {
    encoderPromise = GS1encoder.create().then(gs => {
      gs.includeDataTitlesInHRI = true;
      return gs;
    });
  }
  return encoderPromise;
}

// Common characters scanners use as FNC1/GS (ASCII 29) substitutes
const GS_SUBSTITUTES = [
  { char: "%", name: "percent sign (%)" },
  { char: "~", name: "tilde (~)" },
  { char: "|", name: "pipe (|)" },
];

// Symbology ID → human-readable name
const SYMBOLOGY_NAMES: Record<number, string> = {};

function initSymbologyNames() {
  const s = GS1encoder.symbology;
  SYMBOLOGY_NAMES[s.NONE] = "Unknown";
  SYMBOLOGY_NAMES[s.DataBarOmni] = "GS1 DataBar Omnidirectional";
  SYMBOLOGY_NAMES[s.DataBarTruncated] = "GS1 DataBar Truncated";
  SYMBOLOGY_NAMES[s.DataBarStacked] = "GS1 DataBar Stacked";
  SYMBOLOGY_NAMES[s.DataBarStackedOmni] = "GS1 DataBar Stacked Omni";
  SYMBOLOGY_NAMES[s.DataBarLimited] = "GS1 DataBar Limited";
  SYMBOLOGY_NAMES[s.DataBarExpanded] = "GS1 DataBar Expanded";
  SYMBOLOGY_NAMES[s.UPCA] = "UPC-A";
  SYMBOLOGY_NAMES[s.UPCE] = "UPC-E";
  SYMBOLOGY_NAMES[s.EAN13] = "EAN-13";
  SYMBOLOGY_NAMES[s.EAN8] = "EAN-8";
  SYMBOLOGY_NAMES[s.GS1_128_CCA] = "GS1-128";
  SYMBOLOGY_NAMES[s.GS1_128_CCC] = "GS1-128 (CC-C)";
  SYMBOLOGY_NAMES[s.QR] = "GS1 QR Code";
  SYMBOLOGY_NAMES[s.DM] = "GS1 DataMatrix";
  SYMBOLOGY_NAMES[s.DotCode] = "GS1 DotCode";
}
initSymbologyNames();

/**
 * Parse scan data from the camera scanner (zxing-wasm result).
 * Uses gs1encoder's scanData API with the AIM symbology identifier.
 */
export async function parseGS1ScanData(scan: ScanResult): Promise<ParseResult> {
  const gs = await getEncoder();
  const originalInput = scan.scanData;

  // zxing-wasm may encode GS (ASCII 29) as literal "<GS>" text — normalize to \x1D
  const normalizedText = scan.text.replace(/<GS>/g, "\x1D");
  const normalizedScanData = scan.symbologyIdentifier + normalizedText;
  const hasGroupSeparators = normalizedText.includes("\x1D");

  // Determine confidence from zxing-wasm's contentType and symbologyIdentifier
  const gs1Confidence = determineConfidence(scan.contentType, scan.symbologyIdentifier);

  // If it's not GS1 content, return early without trying to parse AIs
  if (gs1Confidence === "unlikely") {
    return {
      gs1Confidence,
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      symbologyIdentifier: scan.symbologyIdentifier,
      contentType: scan.contentType,
      barcodeFormat: scan.format,
      rawData: scan.text,
      originalInput,
      elements: [],
      errors: [{
        severity: "error",
        message: "This does not appear to be a GS1 barcode. No GS1 content type detected by scanner.",
      }],
      warnings: [],
      hasGroupSeparators,
    };
  }

  // For "likely" barcodes (]C0, ]d1, ]Q1), gs1encoder won't accept the AIM prefix.
  // Go directly to the retry logic without attempting the doomed scanData call.
  if (gs1Confidence === "likely") {
    // GS1 Digital Link: a URL in a ]Q1 QR code is actually compliant — gs1encoder
    // handles ]Q1 + URL natively (but NOT ]Q3 + URL).
    const isDigitalLink = /^https?:\/\//i.test(normalizedText);
    if (isDigitalLink) {
      const dlResult = tryParseDigitalLink(gs, scan.symbologyIdentifier, normalizedText);
      if (dlResult) {
        return {
          gs1Confidence: "confirmed",
          isCompliant: true,
          symbology: "GS1 Digital Link (QR Code)",
          symbologyIdentifier: scan.symbologyIdentifier,
          contentType: scan.contentType,
          barcodeFormat: scan.format,
          rawData: scan.text,
          originalInput,
          elements: dlResult.elements,
          errors: dlResult.errors,
          warnings: dlResult.warnings,
          hasGroupSeparators,
        };
      }
    }

    const retryResult = tryParseAsGS1(gs, scan.symbologyIdentifier, normalizedText);
    if (retryResult) {
      // Single-element parses from non-GS1 barcodes are often false positives —
      // random data like "24000584" can accidentally match AI 240.  Only trust a
      // single-element parse if it's an AI that commonly appears alone (SSCC, GTIN)
      // or if GS separators were present (strong signal of real GS1 structure).
      const isSuspicious = retryResult.elements.length === 1
        && !hasGroupSeparators
        && !["00", "01", "02"].includes(retryResult.elements[0]?.ai ?? "");

      if (isSuspicious) {
        return {
          gs1Confidence: "unlikely",
          isCompliant: false,
          symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
          symbologyIdentifier: scan.symbologyIdentifier,
          contentType: scan.contentType,
          barcodeFormat: scan.format,
          rawData: scan.text,
          originalInput,
          elements: [],
          errors: [{
            severity: "info",
            message: "This does not appear to be a GS1 barcode. Data coincidentally matches AI structure but contains only a single element — likely a standard product or internal code.",
          }],
          warnings: [],
          hasGroupSeparators,
        };
      }

      return {
        gs1Confidence,
        isCompliant: false,
        symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
        symbologyIdentifier: scan.symbologyIdentifier,
        contentType: scan.contentType,
        barcodeFormat: scan.format,
        rawData: scan.text,
        originalInput,
        elements: retryResult.elements,
        errors: retryResult.errors,
        warnings: [{
          severity: "warning",
          message: getMissingFNC1Warning(scan.symbologyIdentifier),
        }, ...retryResult.warnings],
        hasGroupSeparators,
      };
    }
    // Retry failed — try detecting wrong group separator characters.
    // Some scanners/systems substitute FNC1 (GS, ASCII 29) with a printable character.
    // If replacing a candidate char with \x1D makes the data parse, that's the culprit.
    for (const sub of GS_SUBSTITUTES) {
      if (!normalizedText.includes(sub.char)) continue;
      const fixedText = normalizedText.split(sub.char).join("\x1D");
      const fixedResult = tryParseAsGS1(gs, scan.symbologyIdentifier, fixedText);
      if (fixedResult && fixedResult.elements.length > 1) {
        return {
          gs1Confidence: "likely",
          isCompliant: false,
          symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
          symbologyIdentifier: scan.symbologyIdentifier,
          contentType: scan.contentType,
          barcodeFormat: scan.format,
          rawData: scan.text,
          originalInput,
          elements: fixedResult.elements,
          errors: [{
            severity: "error",
            message: `The ${sub.name} character is being used as a group separator instead of FNC1 (ASCII 29 / GS). The scanner or label software must be reconfigured to use the correct GS character.`,
          }, ...fixedResult.errors],
          warnings: [{
            severity: "warning",
            message: getMissingFNC1Warning(scan.symbologyIdentifier),
          }, ...fixedResult.warnings],
          hasGroupSeparators: true,
        };
      }
    }

    // No substitute char detected — fall back to generic error.
    // If the data starts with digits, it plausibly has GS1 AI prefixes but the parser
    // couldn't decode them (e.g. missing GS separators). Keep "likely".
    // If it doesn't start with digits, it's clearly not GS1 — downgrade to "unlikely".
    const looksLikeAI = /^\d{2}/.test(normalizedText);
    if (looksLikeAI) {
      return {
        gs1Confidence,
        isCompliant: false,
        symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
        symbologyIdentifier: scan.symbologyIdentifier,
        contentType: scan.contentType,
        barcodeFormat: scan.format,
        rawData: scan.text,
        originalInput,
        elements: [],
        errors: [{
          severity: "error",
          message: "Data appears to contain GS1 AI prefixes but could not be fully parsed. Check for missing GS (FNC1) field separators between variable-length AIs.",
        }],
        warnings: [{
          severity: "warning",
          message: getMissingFNC1Warning(scan.symbologyIdentifier),
        }],
        hasGroupSeparators,
      };
    }
    return {
      gs1Confidence: "unlikely",
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      symbologyIdentifier: scan.symbologyIdentifier,
      contentType: scan.contentType,
      barcodeFormat: scan.format,
      rawData: scan.text,
      originalInput,
      elements: [],
      errors: [{
        severity: "info",
        message: "This does not appear to be a GS1 barcode. No GS1 Application Identifier structure detected in the data.",
      }],
      warnings: [],
      hasGroupSeparators,
    };
  }

  // ITF-14 fallback: gs1encoder may not accept ]I1 prefix, so handle manually
  if (scan.symbologyIdentifier === "]I1") {
    const itfResult = parseITF14(normalizedText, scan, originalInput, hasGroupSeparators);
    if (itfResult) return itfResult;
  }

  // Try to parse with gs1encoder (for "confirmed" barcodes)
  try {
    gs.scanData = normalizedScanData;

    const hri = gs.hri;
    const symId = gs.sym;
    const symbologyName = SYMBOLOGY_NAMES[symId] ?? `GS1 Barcode (sym=${symId})`;
    const elements = parseHRIElements(hri);

    return {
      gs1Confidence,
      isCompliant: elements.length > 0,
      symbology: symbologyName,
      symbologyIdentifier: scan.symbologyIdentifier,
      contentType: scan.contentType,
      barcodeFormat: scan.format,
      rawData: scan.text,
      originalInput,
      elements,
      errors: [],
      warnings: [],
      hasGroupSeparators,
    };
  } catch (err) {
    const message = err instanceof GS1encoderScanDataException || err instanceof GS1encoderParameterException
      ? err.message
      : String(err);

    // For confirmed GS1 barcodes, try to still extract elements with relaxed validation.
    // The validation error becomes a warning — the barcode IS valid GS1, just has association issues.
    if (gs1Confidence === "confirmed") {
      try {
        gs.validateAIassociations = false;
        gs.scanData = normalizedScanData;
        const hri = gs.hri;
        const symId = gs.sym;
        const symbologyName = SYMBOLOGY_NAMES[symId] ?? `GS1 Barcode (sym=${symId})`;
        const elements = parseHRIElements(hri);
        gs.validateAIassociations = true;

        return {
          gs1Confidence,
          isCompliant: true, // It IS a valid GS1 barcode — associations are advisory
          symbology: symbologyName,
          symbologyIdentifier: scan.symbologyIdentifier,
          contentType: scan.contentType,
          barcodeFormat: scan.format,
          rawData: scan.text,
          originalInput,
          elements,
          errors: [],
          warnings: [{
            severity: "warning",
            message,
          }],
          hasGroupSeparators,
        };
      } catch {
        // Relaxed parse also failed — try detecting wrong group separator characters
        try { gs.validateAIassociations = true; } catch { /* ignore */ }

        for (const sub of GS_SUBSTITUTES) {
          if (!normalizedText.includes(sub.char)) continue;
          const fixedText = normalizedText.split(sub.char).join("\x1D");
          const fixedScanData = scan.symbologyIdentifier + fixedText;
          try {
            gs.scanData = fixedScanData;
            const fixedElements = parseHRIElements(gs.hri);
            if (fixedElements.length > 1) {
              return {
                gs1Confidence,
                isCompliant: false,
                symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
                symbologyIdentifier: scan.symbologyIdentifier,
                contentType: scan.contentType,
                barcodeFormat: scan.format,
                rawData: scan.text,
                originalInput,
                elements: fixedElements,
                errors: [{
                  severity: "error",
                  message: `The ${sub.name} character is being used as a group separator instead of FNC1 (ASCII 29 / GS). The scanner or label software must be reconfigured to use the correct GS character.`,
                }],
                warnings: [],
                hasGroupSeparators: true,
              };
            }
          } catch { /* this substitute didn't help */ }
        }
      }
    }

    return {
      gs1Confidence,
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      symbologyIdentifier: scan.symbologyIdentifier,
      contentType: scan.contentType,
      barcodeFormat: scan.format,
      rawData: scan.text,
      originalInput,
      elements: [],
      errors: [{
        severity: "error",
        message: `GS1 validation error: ${message}`,
      }],
      warnings: [],
      hasGroupSeparators,
    };
  }
}

/**
 * Parse manually entered data (bracketed AI format or raw with symbology prefix).
 */
export async function parseGS1Manual(input: string): Promise<ParseResult> {
  const gs = await getEncoder();
  const originalInput = input;
  const hasGroupSeparators = input.includes("\x1D");

  // Detect if input is bracketed AI format: "(01)..."
  const isBracketed = /^\(\d{2,4}\)/.test(input);

  // Detect if input starts with AIM symbology identifier: "]X#..."
  const hasAIMPrefix = /^\][A-Za-z]\d/.test(input);

  // Detect GS1 Digital Link URI
  const isDigitalLink = /^https?:\/\//i.test(input);

  try {
    if (isBracketed) {
      gs.aiDataStr = input;
    } else if (hasAIMPrefix) {
      gs.scanData = input;
    } else if (isDigitalLink) {
      gs.scanData = "]Q1" + input;
    } else {
      // Try as raw scan data with ]C1 prefix (assume GS1-128 for plain data)
      // If it starts with FNC1 marker "^", use dataStr
      if (input.startsWith("^")) {
        gs.dataStr = input;
      } else {
        // Try bracketed first, fall back to scan data
        try {
          gs.scanData = "]C1" + input;
        } catch {
          // If that fails, try as-is (might be plain AI data)
          gs.aiDataStr = "(" + extractAIGuess(input) + ")" + input;
          throw new Error("Cannot determine data format. Use bracketed AI format, e.g. (01)09521234543213");
        }
      }
    }

    const hri = gs.hri;
    const symId = gs.sym;
    const symbologyName = isDigitalLink ? "GS1 Digital Link" : (SYMBOLOGY_NAMES[symId] ?? "GS1 Barcode");
    const elements = parseHRIElements(hri);

    const gs1Confidence: GS1Confidence = (hasAIMPrefix || isDigitalLink) ? "confirmed" : "likely";
    const aimPrefix = hasAIMPrefix ? input.substring(0, 3) : "";
    const warnings: ValidationMessage[] = [];

    if (!hasAIMPrefix && !isDigitalLink) {
      warnings.push({
        severity: "warning",
        message: "Manual input — GS1 compliance cannot be fully confirmed without scanning the actual barcode.",
      });
    }

    return {
      gs1Confidence,
      isCompliant: elements.length > 0 && gs1Confidence === "confirmed",
      symbology: symbologyName,
      symbologyIdentifier: aimPrefix,
      contentType: isDigitalLink ? "GS1 Digital Link" : hasAIMPrefix ? "GS1" : "Manual",
      barcodeFormat: "Manual Input",
      rawData: input,
      originalInput,
      elements,
      errors: [],
      warnings,
      hasGroupSeparators,
    };
  } catch (err) {
    const message = err instanceof GS1encoderParameterException || err instanceof GS1encoderScanDataException
      ? err.message
      : err instanceof Error ? err.message : String(err);

    return {
      gs1Confidence: "unlikely",
      isCompliant: false,
      symbology: "Unknown",
      symbologyIdentifier: "",
      contentType: "Unknown",
      barcodeFormat: "Manual Input",
      rawData: input,
      originalInput,
      elements: [],
      errors: [{
        severity: "error",
        message: `Parse error: ${message}`,
      }],
      warnings: [],
      hasGroupSeparators,
    };
  }
}

/**
 * Map non-GS1 AIM prefix to its GS1 equivalent for retry parsing.
 */
const GS1_AIM_EQUIVALENTS: Record<string, string> = {
  "]C0": "]C1", // Code 128 → GS1-128
  "]d1": "]d2", // DataMatrix → GS1 DataMatrix
  "]Q1": "]Q3", // QR Code → GS1 QR Code
};

/**
 * Try to parse a GS1 Digital Link URI. gs1encoder accepts ]Q1 + URL directly.
 * Digital Links in ]Q1 QR codes are compliant — they don't need FNC1/]Q3.
 */
function tryParseDigitalLink(
  gs: GS1encoder,
  symbologyIdentifier: string,
  text: string
): { elements: ParsedElement[]; errors: ValidationMessage[]; warnings: ValidationMessage[] } | null {
  try {
    gs.scanData = symbologyIdentifier + text;
    const elements = parseHRIElements(gs.hri);
    if (elements.length === 0) return null;
    return { elements, errors: [], warnings: [] };
  } catch {
    return null;
  }
}

/**
 * Try to parse scan data as GS1 by substituting the AIM prefix with GS1 equivalent.
 * Disables AI association validation since the barcode is already non-compliant.
 * Returns parsed elements + any validation errors/warnings, or null if parsing fails entirely.
 */
function tryParseAsGS1(
  gs: GS1encoder,
  symbologyIdentifier: string,
  text: string
): { elements: ParsedElement[]; errors: ValidationMessage[]; warnings: ValidationMessage[] } | null {
  const gs1Prefix = GS1_AIM_EQUIVALENTS[symbologyIdentifier];
  if (!gs1Prefix) return null;

  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];

  // First pass: disable AI association validation to extract elements
  try {
    gs.validateAIassociations = false;
    gs.scanData = gs1Prefix + text;
    const elements = parseHRIElements(gs.hri);

    // Second pass: re-enable validation to detect association errors
    try {
      gs.validateAIassociations = true;
      gs.scanData = gs1Prefix + text;
    } catch (valErr) {
      // Association validation failed — report as error
      const msg = valErr instanceof GS1encoderScanDataException || valErr instanceof GS1encoderParameterException
        ? valErr.message
        : String(valErr);
      errors.push({ severity: "error", message: msg });
    }

    return { elements, errors, warnings };
  } catch (innerErr) {
    if (import.meta.env.DEV) {
      console.error("[tryParseAsGS1] failed:", innerErr, "| input:", JSON.stringify(gs1Prefix + text), "| charCodes:", [...text.slice(0, 30)].map(c => c.charCodeAt(0)));
    }
    // Return null — data doesn't match any GS1 AI structure
    return null;
  } finally {
    // Always restore validation state
    try { gs.validateAIassociations = true; } catch { /* ignore */ }
  }
}

/**
 * Parse ITF-14 barcode data. ITF-14 can only carry a single GTIN-14.
 * Returns a ParseResult or null if the data doesn't look like a valid GTIN-14.
 */
function parseITF14(
  text: string,
  scan: ScanResult,
  originalInput: string,
  hasGroupSeparators: boolean
): ParseResult | null {
  // ITF-14 must be exactly 14 numeric digits
  if (!/^\d{14}$/.test(text)) return null;

  const errors: ValidationMessage[] = [];
  const isValidCheck = validateCheckDigit(text);
  if (!isValidCheck) {
    errors.push({ severity: "error", message: "GTIN-14 check digit is invalid." });
  }

  const elements: ParsedElement[] = [{
    ai: "01",
    label: "GTIN",
    description: "Global Trade Item Number",
    rawValue: text,
    displayValue: text,
    errors: isValidCheck ? [] : [{ severity: "error", message: "Invalid check digit" }],
    definition: null,
  }];

  return {
    gs1Confidence: "confirmed",
    isCompliant: isValidCheck,
    symbology: "ITF-14",
    symbologyIdentifier: scan.symbologyIdentifier,
    contentType: scan.contentType,
    barcodeFormat: scan.format,
    rawData: text,
    originalInput,
    elements,
    errors,
    warnings: [],
    hasGroupSeparators,
  };
}

/**
 * Parse HRI strings from gs1encoder into ParsedElement objects.
 * With includeDataTitlesInHRI=true, format is: "LABEL (AI) value"
 * Without titles, format is: "(AI) value"
 */
function parseHRIElements(hri: string[]): ParsedElement[] {
  const elements: ParsedElement[] = [];

  for (const line of hri) {
    if (line === "--") continue; // Composite separator

    // Format with data title: "LABEL (AI) value"
    const titleMatch = line.match(/^(.+?)\s+\((\d{2,4})\)\s*(.*)$/);
    if (titleMatch) {
      const label = titleMatch[1]!;
      const ai = titleMatch[2]!;
      const value = titleMatch[3] ?? "";
      elements.push({
        ai,
        label,
        description: label,
        rawValue: value,
        displayValue: value,
        errors: [],
        definition: null,
      });
      continue;
    }

    // Fallback: "(AI) value"
    const match = line.match(/^\((\d{2,4})\)\s*(.*)$/);
    if (match) {
      const ai = match[1]!;
      const value = match[2] ?? "";
      elements.push({
        ai,
        label: `AI (${ai})`,
        description: `AI (${ai})`,
        rawValue: value,
        displayValue: value,
        errors: [],
        definition: null,
      });
    }
  }

  return elements;
}

function determineConfidence(contentType: string, symbologyIdentifier: string): GS1Confidence {
  // contentType === "GS1" means zxing-cpp definitively detected GS1 encoding
  if (contentType === "GS1") {
    return "confirmed";
  }

  // Known GS1 AIM symbology identifiers
  const gs1AIMCodes = ["]C1", "]d2", "]Q3", "]e0", "]e1", "]e2", "]e3"];
  if (gs1AIMCodes.includes(symbologyIdentifier)) {
    return "confirmed";
  }

  // ITF-14: ]I1 is exclusively a GTIN-14 carrier — always GS1
  if (symbologyIdentifier === "]I1") {
    return "confirmed";
  }

  // Non-GS1 AIM codes for symbologies that COULD carry GS1 data (missing FNC1)
  const potentialGS1 = ["]C0", "]d1", "]Q1"];
  if (potentialGS1.includes(symbologyIdentifier)) {
    return "likely";
  }

  return "unlikely";
}

function getMissingFNC1Warning(symbologyIdentifier: string): string {
  switch (symbologyIdentifier) {
    case "]Q1":
      return "This QR Code contains GS1 AI data but is not encoded as a GS1 QR Code. The supplier should encode it with FNC1 in the first position (AIM ID ]Q3).";
    case "]d1":
      return "This DataMatrix contains GS1 AI data but is not encoded as a GS1 DataMatrix. The supplier should encode it with FNC1 in the first position (AIM ID ]d2).";
    case "]C0":
      return "This Code 128 barcode contains GS1 AI data but is not encoded as GS1-128. The supplier should encode it with FNC1 in the first position (AIM ID ]C1).";
    default:
      return "This barcode contains GS1 AI data but is missing the FNC1 prefix character. It is NOT a compliant GS1 barcode.";
  }
}

function mapSymbologyFromAIM(symbologyIdentifier: string, format: string): string {
  const aimMap: Record<string, string> = {
    "]C1": "GS1-128",
    "]C0": "Code-128 (non-GS1)",
    "]d2": "GS1 DataMatrix",
    "]d1": "DataMatrix (non-GS1)",
    "]Q3": "GS1 QR Code",
    "]Q1": "QR Code (non-GS1)",
    "]e0": "GS1 DataBar",
    "]e1": "GS1 DataBar",
    "]e2": "GS1 DataBar",
    "]e3": "GS1 DataBar",
    "]I1": "ITF-14",
  };

  if (aimMap[symbologyIdentifier]) {
    return aimMap[symbologyIdentifier];
  }

  // Fall back to format name
  const formatMap: Record<string, string> = {
    "Code128": "Code-128",
    "QRCode": "QR Code",
    "DataMatrix": "DataMatrix",
    "DataBar": "GS1 DataBar",
    "EAN13": "EAN-13",
    "EAN8": "EAN-8",
    "ITF": "ITF",
  };
  return formatMap[format] ?? format ?? "Unknown";
}

// Attempt to guess AI prefix from raw numeric data (fallback only)
function extractAIGuess(data: string): string {
  if (/^00\d{18}/.test(data)) return "00";
  if (/^01\d{14}/.test(data)) return "01";
  if (/^02\d{14}/.test(data)) return "02";
  return "01"; // default guess
}

// Keep legacy exports for test compatibility
export function validateCheckDigit(value: string): boolean {
  if (value.length < 2) return false;
  if (!/^\d+$/.test(value)) return false;
  const expected = calculateCheckDigit(value.substring(0, value.length - 1));
  return parseInt(value[value.length - 1]!) === expected;
}

export function calculateCheckDigit(valueWithoutCheck: string): number {
  let sum = 0;
  const digits = valueWithoutCheck.split("").reverse();
  for (let i = 0; i < digits.length; i++) {
    const digit = parseInt(digits[i]!);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}
