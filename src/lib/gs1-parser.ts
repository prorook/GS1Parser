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

// The gs1encoder instance is a stateful singleton — setters like `scanData` and
// `validateAIassociations` mutate it. Serialize all parses through a promise
// chain so concurrent callers can't observe or corrupt each other's state.
let parseQueue: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = parseQueue.then(fn, fn);
  // Don't let a rejection break the chain for subsequent callers, but still
  // propagate the original error to this caller.
  parseQueue = next.catch(() => undefined);
  return next;
}

// True only in dev mode AND when the URL has ?debug=1. Use this for logs
// that fire on every non-GS1 scan (and would otherwise spam the console);
// for "this should never happen" warnings, use `import.meta.env.DEV` alone.
function isDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("debug");
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
  return runExclusive(() => parseGS1ScanDataImpl(gs, scan));
}

async function parseGS1ScanDataImpl(gs: GS1encoder, scan: ScanResult): Promise<ParseResult> {
  // zxing-wasm may encode GS (ASCII 29) as literal "<GS>" text — normalize to \x1D
  const normalizedText = scan.text.replace(/<GS>/g, "\x1D");
  const normalizedScanData = scan.symbologyIdentifier + normalizedText;
  const hasGroupSeparators = normalizedText.includes("\x1D");
  const ctx = buildScanContext(scan, scan.scanData, hasGroupSeparators);

  const confidence = determineConfidence(scan.contentType, scan.symbologyIdentifier);

  if (confidence === "unlikely") {
    return makeResult(ctx, {
      gs1Confidence: "unlikely",
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      elements: [],
      errors: [{
        severity: "error",
        message: "This does not appear to be a GS1 barcode. No GS1 content type detected by scanner.",
      }],
      warnings: [],
    });
  }

  if (confidence === "likely") {
    return handleLikely(gs, scan, normalizedText, ctx);
  }

  // ITF-14 fallback: gs1encoder won't accept the ]I1 prefix, so handle manually.
  if (scan.symbologyIdentifier === "]I1") {
    const itfResult = parseITF14(normalizedText, scan, scan.scanData, hasGroupSeparators);
    if (itfResult) return itfResult;
  }

  return handleConfirmed(gs, scan, normalizedScanData, normalizedText, ctx);
}

/**
 * Parse manually entered data (bracketed AI format or raw with symbology prefix).
 */
export async function parseGS1Manual(input: string): Promise<ParseResult> {
  const gs = await getEncoder();
  return runExclusive(() => parseGS1ManualImpl(gs, input));
}

async function parseGS1ManualImpl(gs: GS1encoder, input: string): Promise<ParseResult> {
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
        // Plain data — assume GS1-128 scan data. gs1encoder throws if it can't parse.
        gs.scanData = "]C1" + input;
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
 * Try to parse data that looks like human-readable bracketed AI format: (01)...(10)...
 * This happens when the barcode literally encodes the HRI text with parentheses
 * instead of using proper FNC1 encoding.
 */
function tryParseBracketed(
  gs: GS1encoder,
  text: string
): { elements: ParsedElement[]; errors: ValidationMessage[]; warnings: ValidationMessage[] } | null {
  if (!/^\(\d{2,4}\)/.test(text)) return null;

  // Must have at least 2 bracketed AI patterns to be confident this is HRI text
  const aiPattern = /\(\d{2,4}\)/g;
  const matches = text.match(aiPattern);
  if (!matches || matches.length < 2) return null;

  // Try to parse with gs1encoder for proper element extraction
  try {
    gs.aiDataStr = text;
    const elements = parseHRIElements(gs.hri);
    if (elements.length > 0) {
      return { elements, errors: [], warnings: [] };
    }
  } catch {
    // Parsing failed (e.g. wrong field length, bad check digit) but the pattern
    // is unmistakably bracketed HRI text. Return empty elements with a note.
  }

  // Pattern is clearly bracketed AI text even if gs1encoder can't validate it
  return { elements: [], errors: [{
    severity: "warning",
    message: "Could not fully validate the AI data (possible field length or check digit error), but the bracketed format was detected.",
  }], warnings: [] };
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
    if (isDebugEnabled()) {
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

// ----- Result-building helpers -----

// Fields of ParseResult that come from the scan and don't change as we
// classify the data. Everything else (confidence, compliance, symbology,
// elements, errors, warnings) is decided per code path.
type ResultContext = {
  symbologyIdentifier: string;
  contentType: string;
  barcodeFormat: string;
  rawData: string;
  originalInput: string;
  hasGroupSeparators: boolean;
};

type ResultVariant = {
  gs1Confidence: GS1Confidence;
  isCompliant: boolean;
  symbology: string;
  elements: ParsedElement[];
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  // Only set when this code path proves group separators exist (e.g. after
  // substituting a wrong-GS character into the data).
  hasGroupSeparators?: boolean;
};

function buildScanContext(scan: ScanResult, originalInput: string, hasGroupSeparators: boolean): ResultContext {
  return {
    symbologyIdentifier: scan.symbologyIdentifier,
    contentType: scan.contentType,
    barcodeFormat: scan.format,
    rawData: scan.text,
    originalInput,
    hasGroupSeparators,
  };
}

function makeResult(ctx: ResultContext, variant: ResultVariant): ParseResult {
  return {
    ...ctx,
    ...variant,
    hasGroupSeparators: variant.hasGroupSeparators ?? ctx.hasGroupSeparators,
  };
}

// Messages that show up in more than one place.
const BRACKETED_HRI_MESSAGE = "This barcode contains the human-readable AI text (with parentheses) as its encoded data. The parentheses are NOT supposed to be in the barcode — they are only for printed human-readable text. The label software must encode the data with FNC1 separators, not parentheses.";

function gsSubstituteMessage(subName: string): string {
  return `The ${subName} character is being used as a group separator instead of FNC1 (ASCII 29 / GS). The scanner or label software must be reconfigured to use the correct GS character.`;
}

// ----- Branch handlers -----

// "Likely" branch: AIM ID is ]C0/]d1/]Q1 (or scanner reported non-GS1 content
// type). gs1encoder won't accept those prefixes, so we go straight to retry
// logic. Tries: digital link → AIM-prefix swap → wrong-GS substitution →
// bracketed HRI → generic-AI-prefix fallback → downgrade.
function handleLikely(
  gs: GS1encoder,
  scan: ScanResult,
  normalizedText: string,
  ctx: ResultContext,
): ParseResult {
  // GS1 Digital Link: a URL in a ]Q1 QR code is actually compliant — gs1encoder
  // handles ]Q1 + URL natively (but NOT ]Q3 + URL).
  if (/^https?:\/\//i.test(normalizedText)) {
    const dl = tryParseDigitalLink(gs, scan.symbologyIdentifier, normalizedText);
    if (dl) {
      return makeResult(ctx, {
        gs1Confidence: "confirmed",
        isCompliant: true,
        symbology: "GS1 Digital Link (QR Code)",
        elements: dl.elements,
        errors: dl.errors,
        warnings: dl.warnings,
      });
    }
  }

  const retry = tryParseAsGS1(gs, scan.symbologyIdentifier, normalizedText);
  if (retry) {
    // Single-element parses from non-GS1 barcodes are often false positives —
    // random data like "24000584" can accidentally match AI 240. Only trust a
    // single-element parse if it's an AI that commonly appears alone (SSCC,
    // GTIN) or if GS separators were present.
    const isSuspicious = retry.elements.length === 1
      && !ctx.hasGroupSeparators
      && !["00", "01", "02"].includes(retry.elements[0]?.ai ?? "");

    if (isSuspicious) {
      return makeResult(ctx, {
        gs1Confidence: "unlikely",
        isCompliant: false,
        symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
        elements: [],
        errors: [{
          severity: "info",
          message: "This does not appear to be a GS1 barcode. Data coincidentally matches AI structure but contains only a single element — likely a standard product or internal code.",
        }],
        warnings: [],
      });
    }

    return makeResult(ctx, {
      gs1Confidence: "likely",
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      elements: retry.elements,
      errors: retry.errors,
      warnings: [
        { severity: "warning", message: getMissingFNC1Warning(scan.symbologyIdentifier) },
        ...retry.warnings,
      ],
    });
  }

  // Wrong-GS substitution: some scanners/label software emit a printable char
  // (%, ~, |) where FNC1 should be. If swapping the candidate to \x1D makes
  // the data parse cleanly, that's the culprit.
  const swap = trySubstituteGSCharsViaRetry(gs, scan.symbologyIdentifier, normalizedText);
  if (swap) {
    return makeResult(ctx, {
      gs1Confidence: "likely",
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      elements: swap.result.elements,
      errors: [
        { severity: "error", message: gsSubstituteMessage(swap.subName) },
        ...swap.result.errors,
      ],
      warnings: [
        { severity: "warning", message: getMissingFNC1Warning(scan.symbologyIdentifier) },
        ...swap.result.warnings,
      ],
      hasGroupSeparators: true,
    });
  }

  const bracketed = tryParseBracketed(gs, normalizedText);
  if (bracketed) {
    return makeResult(ctx, {
      gs1Confidence: "likely",
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      elements: bracketed.elements,
      errors: [
        { severity: "error", message: BRACKETED_HRI_MESSAGE },
        ...bracketed.errors,
      ],
      warnings: [
        { severity: "warning", message: getMissingFNC1Warning(scan.symbologyIdentifier) },
      ],
    });
  }

  // Nothing matched. If the data starts with two digits it plausibly has AI
  // prefixes we couldn't decode (missing GS separators); keep "likely". If
  // not, it's clearly not GS1 — downgrade.
  if (/^\d{2}/.test(normalizedText)) {
    return makeResult(ctx, {
      gs1Confidence: "likely",
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      elements: [],
      errors: [{
        severity: "error",
        message: "Data appears to contain GS1 AI prefixes but could not be fully parsed. Check for missing GS (FNC1) field separators between variable-length AIs.",
      }],
      warnings: [
        { severity: "warning", message: getMissingFNC1Warning(scan.symbologyIdentifier) },
      ],
    });
  }

  return makeResult(ctx, {
    gs1Confidence: "unlikely",
    isCompliant: false,
    symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
    elements: [],
    errors: [{
      severity: "info",
      message: "This does not appear to be a GS1 barcode. No GS1 Application Identifier structure detected in the data.",
    }],
    warnings: [],
  });
}

// "Confirmed" branch: AIM ID identifies a GS1 carrier, so we feed the data
// straight to gs1encoder. If strict parse fails, fall through a ladder of
// relaxed retries before giving up with a validation error.
function handleConfirmed(
  gs: GS1encoder,
  scan: ScanResult,
  normalizedScanData: string,
  normalizedText: string,
  ctx: ResultContext,
): ParseResult {
  try {
    gs.scanData = normalizedScanData;
    const elements = parseHRIElements(gs.hri);
    const symbology = SYMBOLOGY_NAMES[gs.sym] ?? `GS1 Barcode (sym=${gs.sym})`;
    return makeResult(ctx, {
      gs1Confidence: "confirmed",
      isCompliant: elements.length > 0,
      symbology,
      elements,
      errors: [],
      warnings: [],
    });
  } catch (err) {
    const message = err instanceof GS1encoderScanDataException || err instanceof GS1encoderParameterException
      ? err.message
      : String(err);

    // Some valid GS1 barcodes fail strict AI-association rules but are still
    // structurally correct. Retry with associations disabled and downgrade the
    // error to a warning.
    const relaxed = tryRelaxedValidation(gs, normalizedScanData);
    if (relaxed) {
      return makeResult(ctx, {
        gs1Confidence: "confirmed",
        isCompliant: true,
        symbology: relaxed.symbology,
        elements: relaxed.elements,
        errors: [],
        warnings: [{ severity: "warning", message }],
      });
    }

    const swap = trySubstituteGSCharsDirect(gs, scan.symbologyIdentifier, normalizedText);
    if (swap) {
      return makeResult(ctx, {
        gs1Confidence: "confirmed",
        isCompliant: false,
        symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
        elements: swap.elements,
        errors: [{ severity: "error", message: gsSubstituteMessage(swap.subName) }],
        warnings: [],
        hasGroupSeparators: true,
      });
    }

    const bracketed = tryParseBracketed(gs, normalizedText);
    if (bracketed) {
      return makeResult(ctx, {
        gs1Confidence: "confirmed",
        isCompliant: false,
        symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
        elements: bracketed.elements,
        errors: [
          { severity: "error", message: BRACKETED_HRI_MESSAGE },
          ...bracketed.errors,
        ],
        warnings: [],
      });
    }

    return makeResult(ctx, {
      gs1Confidence: "confirmed",
      isCompliant: false,
      symbology: mapSymbologyFromAIM(scan.symbologyIdentifier, scan.format),
      elements: [],
      errors: [{ severity: "error", message: `GS1 validation error: ${message}` }],
      warnings: [],
    });
  }
}

// Retry the strict parse with AI-association validation disabled. Returns
// the extracted elements/symbology, or null if even relaxed parsing fails.
// validateAIassociations is restored in finally so the singleton can't leak
// permissive state to subsequent callers.
function tryRelaxedValidation(
  gs: GS1encoder,
  scanData: string,
): { elements: ParsedElement[]; symbology: string } | null {
  let elements: ParsedElement[] | null = null;
  let symbology = "";
  try {
    gs.validateAIassociations = false;
    gs.scanData = scanData;
    elements = parseHRIElements(gs.hri);
    symbology = SYMBOLOGY_NAMES[gs.sym] ?? `GS1 Barcode (sym=${gs.sym})`;
  } catch {
    // Relaxed parse also failed; let the caller try the next fallback.
  } finally {
    try { gs.validateAIassociations = true; } catch { /* ignore */ }
  }
  return elements === null ? null : { elements, symbology };
}

// Loop the known wrong-GS characters and try each as a substitute. Used in
// the confirmed-error path where the scan prefix is already a GS1 AIM ID.
function trySubstituteGSCharsDirect(
  gs: GS1encoder,
  symbologyIdentifier: string,
  normalizedText: string,
): { elements: ParsedElement[]; subName: string } | null {
  for (const sub of GS_SUBSTITUTES) {
    if (!normalizedText.includes(sub.char)) continue;
    const fixedText = normalizedText.split(sub.char).join("\x1D");
    try {
      gs.scanData = symbologyIdentifier + fixedText;
      const fixedElements = parseHRIElements(gs.hri);
      if (fixedElements.length > 1) {
        return { elements: fixedElements, subName: sub.name };
      }
    } catch { /* this substitute didn't help */ }
  }
  return null;
}

// Same idea but routed through tryParseAsGS1 (which swaps non-GS1 AIM IDs
// to their GS1 equivalents). Used in the "likely" branch where the original
// prefix is ]C0/]d1/]Q1 and gs1encoder would reject it as-is.
function trySubstituteGSCharsViaRetry(
  gs: GS1encoder,
  symbologyIdentifier: string,
  normalizedText: string,
): { result: NonNullable<ReturnType<typeof tryParseAsGS1>>; subName: string } | null {
  for (const sub of GS_SUBSTITUTES) {
    if (!normalizedText.includes(sub.char)) continue;
    const fixedText = normalizedText.split(sub.char).join("\x1D");
    const result = tryParseAsGS1(gs, symbologyIdentifier, fixedText);
    if (result && result.elements.length > 1) {
      return { result, subName: sub.name };
    }
  }
  return null;
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
      continue;
    }

    // Neither shape matched. This shouldn't happen with the current
    // gs1encoder output format, so surface it in dev — it would mean either
    // gs1encoder changed its HRI format or we hit an edge case worth seeing.
    if (import.meta.env.DEV) {
      console.warn("[parseHRIElements] unrecognized HRI line:", JSON.stringify(line));
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
