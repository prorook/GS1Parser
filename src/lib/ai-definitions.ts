/**
 * GS1 Application Identifier definitions.
 *
 * Each entry defines:
 * - ai: the AI code string (e.g. "01", "310")
 * - label: human-readable short name
 * - description: full description
 * - fixedLength: number of data characters (excluding AI) if fixed, or undefined if variable
 * - maxLength: maximum data characters for variable-length fields
 * - dataType: "N" (numeric), "X" (alphanumeric), "N6date" (YYMMDD date)
 * - checkDigit: whether the last digit is a check digit (mod-10 weight algorithm)
 * - fnc1required: whether a GS separator is needed after this field (true for variable-length unless last in barcode)
 * - pattern: regex pattern for the AI prefix (for multi-digit variable AIs like 310n)
 */

export interface AIDefinition {
  ai: string;
  label: string;
  description: string;
  fixedLength?: number;
  maxLength?: number;
  dataType: "N" | "X" | "N6date";
  checkDigit?: boolean;
  fnc1required: boolean;
  pattern?: RegExp;
}

// Fixed-length AIs do NOT need a GS separator (fnc1required = false).
// Variable-length AIs DO need a GS separator unless they are last in the element string.

export const AI_DEFINITIONS: AIDefinition[] = [
  // SSCC
  { ai: "00", label: "SSCC", description: "Serial Shipping Container Code", fixedLength: 18, dataType: "N", checkDigit: true, fnc1required: false },

  // GTIN
  { ai: "01", label: "GTIN", description: "Global Trade Item Number", fixedLength: 14, dataType: "N", checkDigit: true, fnc1required: false },

  // Content GTIN (logistics)
  { ai: "02", label: "CONTENT", description: "GTIN of items in logistic unit", fixedLength: 14, dataType: "N", checkDigit: true, fnc1required: false },

  // MTO GTIN
  { ai: "03", label: "MTO GTIN", description: "Made-to-Order GTIN", fixedLength: 14, dataType: "N", checkDigit: true, fnc1required: false },

  // Batch/Lot
  { ai: "10", label: "BATCH/LOT", description: "Batch or lot number", maxLength: 20, dataType: "X", fnc1required: true },

  // Dates
  { ai: "11", label: "PROD DATE", description: "Production date", fixedLength: 6, dataType: "N6date", fnc1required: false },
  { ai: "12", label: "DUE DATE", description: "Due date", fixedLength: 6, dataType: "N6date", fnc1required: false },
  { ai: "13", label: "PACK DATE", description: "Packaging date", fixedLength: 6, dataType: "N6date", fnc1required: false },
  { ai: "15", label: "BEST BY", description: "Best before date", fixedLength: 6, dataType: "N6date", fnc1required: false },
  { ai: "16", label: "SELL BY", description: "Sell by date", fixedLength: 6, dataType: "N6date", fnc1required: false },
  { ai: "17", label: "EXPIRY", description: "Expiration date", fixedLength: 6, dataType: "N6date", fnc1required: false },

  // Variant
  { ai: "20", label: "VARIANT", description: "Internal product variant", fixedLength: 2, dataType: "N", fnc1required: false },

  // Serial
  { ai: "21", label: "SERIAL", description: "Serial number", maxLength: 20, dataType: "X", fnc1required: true },

  // Consumer product variant
  { ai: "22", label: "CPV", description: "Consumer product variant", maxLength: 20, dataType: "X", fnc1required: true },

  // Additional IDs
  { ai: "235", label: "TPX", description: "Third Party Controlled Extension of GTIN", maxLength: 28, dataType: "X", fnc1required: true },
  { ai: "240", label: "ADDITIONAL ID", description: "Additional product identification", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "241", label: "CUST. PART No.", description: "Customer part number", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "242", label: "MTO VARIANT", description: "Made-to-Order variation number", maxLength: 6, dataType: "N", fnc1required: true },
  { ai: "243", label: "PCN", description: "Packaging component number", maxLength: 20, dataType: "X", fnc1required: true },
  { ai: "250", label: "SECONDARY SERIAL", description: "Secondary serial number", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "251", label: "REF. TO SOURCE", description: "Reference to source entity", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "253", label: "GDTI", description: "Global Document Type Identifier", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "254", label: "GLN EXT", description: "GLN extension component", maxLength: 20, dataType: "X", fnc1required: true },
  { ai: "255", label: "GCN", description: "Global Coupon Number", maxLength: 25, dataType: "N", fnc1required: true },

  // Variable count
  { ai: "30", label: "VAR. COUNT", description: "Variable count of items", maxLength: 8, dataType: "N", fnc1required: true },

  // Net weight kg (310n - 315n)
  { ai: "3100", label: "NET WEIGHT (kg)", description: "Net weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3101", label: "NET WEIGHT (kg)", description: "Net weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3102", label: "NET WEIGHT (kg)", description: "Net weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3103", label: "NET WEIGHT (kg)", description: "Net weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3104", label: "NET WEIGHT (kg)", description: "Net weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3105", label: "NET WEIGHT (kg)", description: "Net weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },

  // Net weight lb (320n)
  { ai: "3200", label: "NET WEIGHT (lb)", description: "Net weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3201", label: "NET WEIGHT (lb)", description: "Net weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3202", label: "NET WEIGHT (lb)", description: "Net weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3203", label: "NET WEIGHT (lb)", description: "Net weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3204", label: "NET WEIGHT (lb)", description: "Net weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3205", label: "NET WEIGHT (lb)", description: "Net weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },

  // Gross weight kg (330n)
  { ai: "3300", label: "GROSS WEIGHT (kg)", description: "Logistic weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3301", label: "GROSS WEIGHT (kg)", description: "Logistic weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3302", label: "GROSS WEIGHT (kg)", description: "Logistic weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3303", label: "GROSS WEIGHT (kg)", description: "Logistic weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3304", label: "GROSS WEIGHT (kg)", description: "Logistic weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3305", label: "GROSS WEIGHT (kg)", description: "Logistic weight, kilograms", fixedLength: 6, dataType: "N", fnc1required: false },

  // Gross weight lb (340n)
  { ai: "3400", label: "GROSS WEIGHT (lb)", description: "Logistic weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3401", label: "GROSS WEIGHT (lb)", description: "Logistic weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3402", label: "GROSS WEIGHT (lb)", description: "Logistic weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3403", label: "GROSS WEIGHT (lb)", description: "Logistic weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3404", label: "GROSS WEIGHT (lb)", description: "Logistic weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },
  { ai: "3405", label: "GROSS WEIGHT (lb)", description: "Logistic weight, pounds", fixedLength: 6, dataType: "N", fnc1required: false },

  // Count of trade items in logistic unit
  { ai: "37", label: "COUNT", description: "Count of trade items in logistic unit", maxLength: 8, dataType: "N", fnc1required: true },

  // Amount payable
  { ai: "3900", label: "AMOUNT", description: "Amount payable, single monetary area", maxLength: 15, dataType: "N", fnc1required: true },
  { ai: "3901", label: "AMOUNT", description: "Amount payable, single monetary area", maxLength: 15, dataType: "N", fnc1required: true },
  { ai: "3902", label: "AMOUNT", description: "Amount payable, single monetary area", maxLength: 15, dataType: "N", fnc1required: true },

  // Order number
  { ai: "400", label: "ORDER NUMBER", description: "Customer's purchase order number", maxLength: 30, dataType: "X", fnc1required: true },

  // GINC, GSIN, Route
  { ai: "401", label: "GINC", description: "Global Identification Number for Consignment", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "402", label: "GSIN", description: "Global Shipment Identification Number", fixedLength: 17, dataType: "N", fnc1required: false },
  { ai: "403", label: "ROUTE", description: "Routing code", maxLength: 30, dataType: "X", fnc1required: true },

  // GLN locations
  { ai: "410", label: "SHIP TO LOC", description: "Ship to GLN", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },
  { ai: "411", label: "BILL TO", description: "Bill to GLN", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },
  { ai: "412", label: "PURCHASE FROM", description: "Purchased from GLN", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },
  { ai: "413", label: "SHIP FOR LOC", description: "Ship for / Deliver for GLN", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },
  { ai: "414", label: "LOC No.", description: "Physical location GLN", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },
  { ai: "415", label: "PAY TO", description: "GLN of invoicing party", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },
  { ai: "416", label: "PROD/SERV LOC", description: "GLN of production/service location", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },
  { ai: "417", label: "PARTY", description: "Party GLN", fixedLength: 13, dataType: "N", checkDigit: true, fnc1required: false },

  // Postal codes
  { ai: "420", label: "SHIP TO POST", description: "Ship to postal code", maxLength: 20, dataType: "X", fnc1required: true },
  { ai: "421", label: "SHIP TO POST", description: "Ship to postal code with ISO country", maxLength: 15, dataType: "X", fnc1required: true },
  { ai: "422", label: "ORIGIN", description: "Country of origin", fixedLength: 3, dataType: "N", fnc1required: false },
  { ai: "423", label: "COUNTRY - INITIAL PROCESS", description: "Country of initial processing", maxLength: 15, dataType: "N", fnc1required: true },
  { ai: "424", label: "COUNTRY - PROCESS", description: "Country of processing", fixedLength: 3, dataType: "N", fnc1required: false },
  { ai: "425", label: "COUNTRY - DISASSEMBLY", description: "Country of disassembly", maxLength: 15, dataType: "N", fnc1required: true },
  { ai: "426", label: "COUNTRY - FULL PROCESS", description: "Country covering full process chain", fixedLength: 3, dataType: "N", fnc1required: false },

  // Internal
  { ai: "90", label: "INTERNAL", description: "Information mutually agreed between trading partners", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "91", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "92", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "93", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "94", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "95", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "96", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "97", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "98", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },
  { ai: "99", label: "INTERNAL", description: "Company internal information", maxLength: 90, dataType: "X", fnc1required: true },

  // GRAI, GIAI
  { ai: "8003", label: "GRAI", description: "Global Returnable Asset Identifier", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "8004", label: "GIAI", description: "Global Individual Asset Identifier", maxLength: 30, dataType: "X", fnc1required: true },

  // ITIP
  { ai: "8006", label: "ITIP", description: "Identification of an individual trade item piece", fixedLength: 18, dataType: "N", fnc1required: false },

  // Production time
  { ai: "8008", label: "PROD TIME", description: "Date and time of production", maxLength: 12, dataType: "N", fnc1required: true },

  // CPID
  { ai: "8010", label: "CPID", description: "Component/Part Identifier", maxLength: 30, dataType: "X", fnc1required: true },
  { ai: "8011", label: "CPID SERIAL", description: "Component/Part Identifier serial number", maxLength: 12, dataType: "N", fnc1required: true },

  // Software version
  { ai: "8012", label: "VERSION", description: "Software version", maxLength: 20, dataType: "X", fnc1required: true },

  // GMN
  { ai: "8013", label: "GMN", description: "Global Model Number", maxLength: 25, dataType: "X", fnc1required: true },
];

/**
 * Build a lookup structure for fast AI prefix matching.
 * We try 4-digit, then 3-digit, then 2-digit prefixes.
 */
const aiByPrefix = new Map<string, AIDefinition>();
for (const def of AI_DEFINITIONS) {
  aiByPrefix.set(def.ai, def);
}

/**
 * Look up an AI definition by matching the longest prefix at position `pos` in the input string.
 * Returns the matched definition and the number of characters consumed by the AI prefix.
 */
export function lookupAI(data: string, pos: number): { def: AIDefinition; prefixLength: number } | null {
  // Try 4-digit prefix first, then 3, then 2
  for (const len of [4, 3, 2]) {
    if (pos + len > data.length) continue;
    const prefix = data.substring(pos, pos + len);
    const def = aiByPrefix.get(prefix);
    if (def) {
      return { def, prefixLength: len };
    }
  }
  return null;
}
