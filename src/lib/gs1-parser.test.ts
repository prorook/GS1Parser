import { describe, it, expect } from "vitest";
import { parseGS1ScanData, parseGS1Manual, validateCheckDigit, calculateCheckDigit } from "./gs1-parser";
import type { ScanResult } from "../components/BarcodeScanner";

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
});
