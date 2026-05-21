import { describe, it, expect } from "vitest";
import {
  parseGS1ScanData,
  parseGS1Manual,
  validateCheckDigit,
  calculateCheckDigit,
  validateElementSemantics,
  validateGlobalSemantics,
} from "./gs1-parser";
import type { ParsedElement } from "./gs1-parser";
import type { ScanResult } from "../components/BarcodeScanner";

function makeElement(ai: string, value: string): ParsedElement {
  return {
    ai,
    label: `AI (${ai})`,
    description: `AI (${ai})`,
    rawValue: value,
    displayValue: value,
    errors: [],
    definition: null,
  };
}

const GS = "\x1D";

function makeScanResult(overrides: Partial<ScanResult> & { scanData: string }): ScanResult {
  return {
    symbologyIdentifier: "]C1",
    text: overrides.scanData.replace(/^\][A-Za-z]\d/, ""),
    contentType: "GS1",
    format: "Code128",
    ...overrides,
  };
}

describe("GS1 Parser (gs1encoder)", () => {
  describe("Check digit validation", () => {
    it("validates GTIN-14 check digit", () => {
      expect(validateCheckDigit("00614141123452")).toBe(true);
      expect(validateCheckDigit("00614141123451")).toBe(false);
    });

    it("calculates correct check digit", () => {
      expect(calculateCheckDigit("0061414112345")).toBe(2);
    });

    it("validates SSCC check digit", () => {
      const base = "34012345000000001";
      const cd = calculateCheckDigit(base);
      const validSSCC = base + cd.toString();
      expect(validateCheckDigit(validSSCC)).toBe(true);
      const wrongCD = (cd + 1) % 10;
      expect(validateCheckDigit(base + wrongCD.toString())).toBe(false);
    });
  });

  describe("Scan data parsing", () => {
    it("parses GS1-128 scan data with symbology identifier", async () => {
      const scan = makeScanResult({
        scanData: "]C10100614141123452",
        symbologyIdentifier: "]C1",
        text: "0100614141123452",
        contentType: "GS1",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.elements.length).toBeGreaterThan(0);
      expect(result.elements[0]?.ai).toBe("01");
    });

    it("parses GS1 DataMatrix scan data", async () => {
      const scan = makeScanResult({
        scanData: "]d20100614141123452",
        symbologyIdentifier: "]d2",
        text: "0100614141123452",
        contentType: "GS1",
        format: "DataMatrix",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.symbology).toContain("DataMatrix");
    });

    it("detects non-GS1 barcode", async () => {
      const scan = makeScanResult({
        scanData: "]C0HELLO WORLD",
        symbologyIdentifier: "]C0",
        text: "HELLO WORLD",
        contentType: "Text",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      // ]C0 initially classified as "likely" but downgraded to "unlikely"
      // when data doesn't match any GS1 AI structure
      expect(result.gs1Confidence).toBe("unlikely");
      expect(result.isCompliant).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("parses GTIN + batch + expiry", async () => {
      const scan = makeScanResult({
        scanData: `]C1010061414112345217251231${GS}10ABC123`,
        symbologyIdentifier: "]C1",
        text: `010061414112345217251231${GS}10ABC123`,
        contentType: "GS1",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.isCompliant).toBe(true);
      expect(result.elements.length).toBe(3);
      expect(result.elements[0]?.ai).toBe("01");
      expect(result.elements[1]?.ai).toBe("17");
      expect(result.elements[2]?.ai).toBe("10");
    });
  });

  describe("Manual input parsing", () => {
    it("parses bracketed AI format", async () => {
      const result = await parseGS1Manual("(01)00614141123452(17)251231(10)ABC123");
      expect(result.elements.length).toBe(3);
      expect(result.elements[0]?.ai).toBe("01");
      expect(result.elements[1]?.ai).toBe("17");
      expect(result.elements[2]?.ai).toBe("10");
    });

    it("parses input with AIM symbology prefix", async () => {
      const result = await parseGS1Manual(`]C1010061414112345210LOT123`);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.elements.length).toBeGreaterThan(0);
    });

    it("reports error for invalid data", async () => {
      const result = await parseGS1Manual("(01)NOTANUMBER");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("reports error for invalid check digit in bracketed format", async () => {
      // Last digit should be 2, using 9
      const result = await parseGS1Manual("(01)00614141123459");
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("GS1 DataBar scan data", () => {
    it("parses DataBar scan with ]e0 prefix", async () => {
      const scan = makeScanResult({
        scanData: "]e00100614141123452",
        symbologyIdentifier: "]e0",
        text: "0100614141123452",
        contentType: "GS1",
        format: "DataBar",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.elements[0]?.ai).toBe("01");
    });
  });

  describe("Non-compliant vendor labels (]C0 with GS1 AI data)", () => {
    it("parses ]C0 barcode with GS1 AI structure and GS separators", async () => {
      const scan = makeScanResult({
        scanData: "]C024124000584\x1D15270518\x1D301400\x1D10710353",
        symbologyIdentifier: "]C0",
        text: "24124000584\x1D15270518\x1D301400\x1D10710353",
        contentType: "Text",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("likely");
      expect(result.isCompliant).toBe(false);
      expect(result.elements.length).toBe(4);
      expect(result.elements[0]?.ai).toBe("241");
      expect(result.elements[0]?.label).toBe("CUST. PART No.");
      expect(result.elements[1]?.ai).toBe("15");
      expect(result.elements[2]?.ai).toBe("30");
      expect(result.elements[3]?.ai).toBe("10");
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]?.message).toContain("FNC1");
    });
  });

  describe("ITF-14 barcodes", () => {
    it("parses ITF-14 scan with ]I1 prefix as GTIN-14", async () => {
      const scan = makeScanResult({
        scanData: "]I100614141123452",
        symbologyIdentifier: "]I1",
        text: "00614141123452",
        contentType: "Text",
        format: "ITF",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.isCompliant).toBe(true);
      expect(result.symbology).toBe("ITF-14");
      expect(result.elements.length).toBe(1);
      expect(result.elements[0]?.ai).toBe("01");
      expect(result.elements[0]?.displayValue).toBe("00614141123452");
    });

    it("reports a clear error for malformed ITF-14 data (wrong length / non-numeric)", async () => {
      const scan = makeScanResult({
        scanData: "]I1ABC123",
        symbologyIdentifier: "]I1",
        text: "ABC123",
        contentType: "Text",
        format: "ITF",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.isCompliant).toBe(false);
      expect(result.symbology).toBe("ITF-14");
      expect(result.errors[0]?.message).toContain("14 numeric digits");
    });

    it("reports invalid check digit for ITF-14", async () => {
      const scan = makeScanResult({
        scanData: "]I100614141123459",
        symbologyIdentifier: "]I1",
        text: "00614141123459",
        contentType: "Text",
        format: "ITF",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.isCompliant).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.message).toContain("check digit");
    });
  });

  describe("Concurrent parses (singleton mutex)", () => {
    it("interleaved confirmed + likely parses do not corrupt each other", async () => {
      // Run a confirmed parse, a likely parse that triggers relaxed validation,
      // and a non-GS1 parse all at once. Without serialization, the shared
      // gs1encoder's validateAIassociations / scanData state would race and
      // produce wrong results or thrown errors.
      const confirmed = makeScanResult({
        scanData: `]C1010061414112345210ABC`,
        symbologyIdentifier: "]C1",
        text: `010061414112345210ABC`,
        contentType: "GS1",
        format: "Code128",
      });
      const likely = makeScanResult({
        scanData: `]C024124000584\x1D15270518\x1D301400\x1D10710353`,
        symbologyIdentifier: "]C0",
        text: `24124000584\x1D15270518\x1D301400\x1D10710353`,
        contentType: "Text",
        format: "Code128",
      });
      const notGS1 = makeScanResult({
        scanData: "]C0HELLO WORLD",
        symbologyIdentifier: "]C0",
        text: "HELLO WORLD",
        contentType: "Text",
        format: "Code128",
      });

      // 20 interleaved parses
      const tasks: Promise<{ kind: string; result: Awaited<ReturnType<typeof parseGS1ScanData>> }>[] = [];
      for (let i = 0; i < 20; i++) {
        const pick = i % 3 === 0 ? confirmed : i % 3 === 1 ? likely : notGS1;
        const kind = i % 3 === 0 ? "confirmed" : i % 3 === 1 ? "likely" : "notGS1";
        tasks.push(parseGS1ScanData(pick).then(result => ({ kind, result })));
      }
      const results = await Promise.all(tasks);

      for (const { kind, result } of results) {
        if (kind === "confirmed") {
          expect(result.gs1Confidence).toBe("confirmed");
          expect(result.isCompliant).toBe(true);
          expect(result.elements[0]?.ai).toBe("01");
        } else if (kind === "likely") {
          expect(result.gs1Confidence).toBe("likely");
          expect(result.elements.length).toBe(4);
        } else {
          expect(result.gs1Confidence).toBe("unlikely");
        }
      }
    });
  });

  describe("GTIN indicator-digit warning", () => {
    it("flags AI (01) GTIN starting with 0 as suspicious for logistic labels", async () => {
      const scan = makeScanResult({
        scanData: "]C10100614141123452",
        symbologyIdentifier: "]C1",
        text: "0100614141123452",
        contentType: "GS1",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      const gtin = result.elements.find((e) => e.ai === "01");
      expect(gtin).toBeDefined();
      expect(gtin?.errors.some((e) => e.severity === "warning" && e.message.includes("indicator digit"))).toBe(true);
    });

    it("does not flag AI (01) GTIN with non-zero indicator", async () => {
      // GTIN-14 with indicator digit 1, valid check digit
      const base = "1061414112345";
      const cd = calculateCheckDigit(base);
      const gtin14 = base + cd;
      const scan = makeScanResult({
        scanData: `]C101${gtin14}`,
        symbologyIdentifier: "]C1",
        text: `01${gtin14}`,
        contentType: "GS1",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      const gtin = result.elements.find((e) => e.ai === "01");
      expect(gtin).toBeDefined();
      expect(gtin?.errors.some((e) => e.message.includes("indicator digit"))).toBe(false);
    });

    it("does not flag AI (02) starting with 0 (content GTIN is supposed to be the consumer GTIN)", async () => {
      const scan = makeScanResult({
        scanData: `]C10200614141123452\x1D37100`,
        symbologyIdentifier: "]C1",
        text: `0200614141123452\x1D37100`,
        contentType: "GS1",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      const content = result.elements.find((e) => e.ai === "02");
      expect(content).toBeDefined();
      expect(content?.errors.some((e) => e.message.includes("indicator digit"))).toBe(false);
    });

    it("flags ITF-14 GTIN starting with 0", async () => {
      const scan = makeScanResult({
        scanData: "]I100614141123452",
        symbologyIdentifier: "]I1",
        text: "00614141123452",
        contentType: "Text",
        format: "ITF",
      });
      const result = await parseGS1ScanData(scan);
      const gtin = result.elements[0];
      expect(gtin?.errors.some((e) => e.severity === "warning" && e.message.includes("indicator digit"))).toBe(true);
    });
  });

  describe("Date day=00 warning", () => {
    it("flags AI (17) expiration date with day=00", () => {
      const msgs = validateElementSemantics("17", "251200");
      expect(msgs.some((m) => m.severity === "warning" && m.message.includes("day component is 00"))).toBe(true);
    });

    it("flags AI (11) production date with day=00", () => {
      const msgs = validateElementSemantics("11", "240800");
      expect(msgs.some((m) => m.message.includes("day component is 00"))).toBe(true);
    });

    it("does not flag a date with a valid day", () => {
      const msgs = validateElementSemantics("17", "251231");
      expect(msgs.some((m) => m.message.includes("day component is 00"))).toBe(false);
    });

    it("does not flag non-date AIs that happen to end in 00", () => {
      // AI 10 (lot) is not a date; value "ABC100" has positions 4-5 == "00"
      // but the check should only apply to known date AIs.
      const msgs = validateElementSemantics("10", "ABC100");
      expect(msgs.some((m) => m.message.includes("day component"))).toBe(false);
    });

    it("surfaces day=00 warning end-to-end via parseGS1Manual", async () => {
      const result = await parseGS1Manual("(01)00614141123452(17)251200");
      const expiry = result.elements.find((e) => e.ai === "17");
      expect(expiry?.errors.some((e) => e.message.includes("day component is 00"))).toBe(true);
    });
  });

  describe("Duplicate AI warning", () => {
    it("flags a label with two GTINs", () => {
      const msgs = validateGlobalSemantics([
        makeElement("01", "00614141123452"),
        makeElement("01", "10614141123459"),
      ]);
      expect(msgs.some((m) => m.severity === "warning" && m.message.includes("Duplicate"))).toBe(true);
    });

    it("does not flag a label with distinct AIs", () => {
      const msgs = validateGlobalSemantics([
        makeElement("01", "00614141123452"),
        makeElement("17", "251231"),
        makeElement("10", "ABC123"),
      ]);
      expect(msgs.some((m) => m.message.includes("Duplicate"))).toBe(false);
    });

    // No end-to-end test for duplicates: gs1encoder rejects duplicate AIs at
    // parse time, so the elements array never contains them. The check still
    // fires on the rare paths that bypass strict validation (relaxed-parse
    // fallback, manual element construction) — covered by the unit tests
    // above and by the makeResult wiring exercised in other e2e cases.
  });

  describe("Empty lot/serial warning", () => {
    it("flags empty AI (10) batch/lot number", () => {
      const msgs = validateElementSemantics("10", "");
      expect(msgs.some((m) => m.severity === "warning" && m.message.includes("Batch/Lot"))).toBe(true);
    });

    it("flags empty AI (21) serial number", () => {
      const msgs = validateElementSemantics("21", "");
      expect(msgs.some((m) => m.message.includes("Serial"))).toBe(true);
    });

    it("does not flag a non-empty lot value", () => {
      const msgs = validateElementSemantics("10", "ABC123");
      expect(msgs.some((m) => m.message.includes("present but empty"))).toBe(false);
    });
  });

  describe("GS1 training/example prefix warning", () => {
    it("flags AI (01) with 0614141 company prefix", () => {
      const msgs = validateElementSemantics("01", "00614141123452");
      expect(msgs.some((m) => m.severity === "warning" && m.message.includes("training/example"))).toBe(true);
    });

    it("flags AI (02) with 0614141 company prefix", () => {
      const msgs = validateElementSemantics("02", "00614141123452");
      expect(msgs.some((m) => m.message.includes("training/example"))).toBe(true);
    });

    it("does not flag a GTIN with a real-looking company prefix", () => {
      // Indicator 1, non-test company prefix
      const base = "1123456712345";
      const gtin = base + calculateCheckDigit(base);
      const msgs = validateElementSemantics("01", gtin);
      expect(msgs.some((m) => m.message.includes("training/example"))).toBe(false);
    });

    it("surfaces test-prefix warning end-to-end via parseGS1Manual", async () => {
      const result = await parseGS1Manual("(01)00614141123452");
      const gtin = result.elements.find((e) => e.ai === "01");
      expect(gtin?.errors.some((e) => e.message.includes("training/example"))).toBe(true);
    });
  });

  describe("Variable-measure GTIN without measurement AI warning", () => {
    it("flags indicator-9 GTIN with no measurement AI", () => {
      const base = "9061414112345";
      const gtin = base + calculateCheckDigit(base);
      const msgs = validateGlobalSemantics([makeElement("01", gtin)]);
      expect(msgs.some((m) => m.severity === "warning" && m.message.includes("Variable-measure"))).toBe(true);
    });

    it("does not flag indicator-9 GTIN paired with a measurement AI (3103 net weight kg)", () => {
      const base = "9061414112345";
      const gtin = base + calculateCheckDigit(base);
      const msgs = validateGlobalSemantics([
        makeElement("01", gtin),
        makeElement("3103", "001234"),
      ]);
      expect(msgs.some((m) => m.message.includes("Variable-measure"))).toBe(false);
    });

    it("does not flag indicator-1 GTIN even without a measurement AI", () => {
      const base = "1061414112345";
      const gtin = base + calculateCheckDigit(base);
      const msgs = validateGlobalSemantics([makeElement("01", gtin)]);
      expect(msgs.some((m) => m.message.includes("Variable-measure"))).toBe(false);
    });

    it("surfaces variable-measure warning end-to-end via parseGS1Manual", async () => {
      const base = "9061414112345";
      const gtin = base + calculateCheckDigit(base);
      const result = await parseGS1Manual(`(01)${gtin}`);
      expect(result.warnings.some((w) => w.message.includes("Variable-measure"))).toBe(true);
    });
  });

  describe("Bracketed HRI text encoded in barcode", () => {
    it("detects ]C1 barcode with parenthesized AI text as encoded data", async () => {
      const scan = makeScanResult({
        scanData: "]C1(01)0001159022019(11)211117(17)220418(30)12(10)21321200212",
        symbologyIdentifier: "]C1",
        text: "(01)0001159022019(11)211117(17)220418(30)12(10)21321200212",
        contentType: "GS1",
        format: "Code128",
      });
      const result = await parseGS1ScanData(scan);
      expect(result.gs1Confidence).toBe("confirmed");
      expect(result.isCompliant).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.message).toContain("parentheses");
      expect(result.errors[0]?.message).toContain("human-readable");
    });
  });
});
