# GS1 Barcode Parser - Brainstorm

## Problem Statement
Vendors send labels that aren't GS1 compliant:
- Missing FNC1 start character (just a plain Code-128)
- Incorrect or missing Group Separators (GS, ASCII 29 / `\x1D`)
- AI code values that don't match the defined format (wrong length, wrong data type)
- Missing mandatory paired AIs (e.g., AI `02` without AI `37`)
- AI `241` used in place of AI `01` (GTIN) when vendor doesn't have one (bad practice)

### Key AIs We Care About
| AI | Use |
|----|-----|
| 01 | GTIN (primary item identifier) |
| 241 | Customer part number (our internal item ID — used when vendor has no GTIN) |
| 15 | Best before date |
| 17 | Expiry date |
| 10 | Batch/lot number |
| 30 | Variable count |
| 320n | Net weight (variable weight items) |

---

## Architecture: Power Apps Code App (React + TypeScript + Vite)

### What Are Code Apps?
Code Apps are a **GA Power Apps feature** that lets you build full custom web apps using:
- React, TypeScript, Vite, Tailwind CSS
- `@microsoft/power-apps` npm SDK for connectors/auth
- Deploy via `pac code push` to Power Platform
- Users access via browser (phone or desktop)
- Managed by Power Platform governance (DLP, Conditional Access, sharing)
- **Requires Power Apps Premium license** (users already have this)

GitHub: https://github.com/microsoft/PowerAppsCodeApps  
Docs: https://learn.microsoft.com/en-us/power-apps/developer/code-apps/  
Starter template: React + Vite + Tailwind CSS + Tanstack Query + React Router

### Why Code Apps Over Canvas Apps?
| Issue | Canvas App | Code App |
|-------|-----------|----------|
| Barcode scanner output | Raw text only — **strips FNC1 and symbology identifiers** | We control the decoder (ZXing-js) — **preserves GS characters and can detect symbology** |
| Parser logic | Would need Power Automate + Azure Function | All TypeScript, runs client-side in-browser |
| UI flexibility | Limited to Power Apps controls | Full React — tables, color-coded results, whatever we want |
| Offline capability | Limited | Works offline once loaded (all logic is client-side) |
| Camera control | Black box | Full control via browser MediaDevices API |

### Key Limitation
> "Code apps aren't supported in the Power Apps mobile app or Power Apps for Windows."

**This is fine** — the app runs as a web app in the phone's browser (Safari/Chrome). 
Users open a URL or bookmark. Camera access works via standard web APIs.

---

## Architecture Diagram
```
┌─────────────────────────────────────────────────────┐
│  Phone Browser (Safari / Chrome)                    │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  React + TypeScript + Vite (Code App)         │  │
│  │                                               │  │
│  │  ┌─────────────┐    ┌─────────────────────┐  │  │
│  │  │ ZXing-js    │───▶│ GS1 Parser Engine   │  │  │
│  │  │ (camera +   │    │ (TypeScript)         │  │  │
│  │  │  decode)    │    │                      │  │  │
│  │  │             │    │ • Symbology detect   │  │  │
│  │  │ Code128     │    │ • FNC1/GS detection  │  │  │
│  │  │ DataMatrix  │    │ • AI parsing         │  │  │
│  │  │ QR Code     │    │ • Validation         │  │  │
│  │  └─────────────┘    │ • Business rules     │  │  │
│  │                      └──────────┬──────────┘  │  │
│  │                                 │             │  │
│  │                      ┌──────────▼──────────┐  │  │
│  │                      │ Results UI          │  │  │
│  │                      │ (React components)  │  │  │
│  │                      │                     │  │  │
│  │                      │ ✅/❌ Compliance     │  │  │
│  │                      │ 📋 Parsed AIs       │  │  │
│  │                      │ ⚠️  Warnings         │  │  │
│  │                      └─────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  Power Apps Host (auth, governance, hosting)        │
└─────────────────────────────────────────────────────┘
```

---

## The Scanner Problem: Why This Matters

### What happens when a scanner decodes a barcode?

**GS1-128 (Code 128 with FNC1):**
- FNC1 in position 1 = "this is GS1" signal
- FNC1 in other positions = field separator for variable-length fields
- Good scanners output: symbology prefix `]C1` + data with GS chars (`\x1D`) as separators
- Bad/simple scanners output: just the text, FNC1 info LOST

**Plain Code-128 (no FNC1):**
- Scanners output: `]C0` prefix (or no prefix) + raw text
- Looks identical to GS1-128 data if you don't have the symbology info!

**ZXing-js behavior (what we'd use):**
- Detects GS1 mode for Code128, DataMatrix, QR
- Outputs `\x1D` (GS character, ASCII 29) for FNC1-as-separator
- Can indicate the barcode format/type detected
- Gives us the information we need to distinguish GS1 vs non-GS1

### Our Detection Strategy
```
1. ZXing decodes barcode → returns { text, format }
2. Check format: 
   - If DataMatrix or QR in GS1 mode → confirmed GS1
   - If Code128 → check for symbology ID or GS chars
3. If no GS1 indicators found:
   - Attempt "best effort" parse (pattern-match known AI prefixes)
   - Flag as "⚠️ Possibly non-GS1 — no FNC1 detected"
   - Show what we THINK the data is, with caveats
```

---

## GS1 Parser Logic (TypeScript)

### Detection: Is it GS1?
1. **ZXing format detection** — ZXing tells us the barcode type (CODE_128, DATA_MATRIX, QR_CODE)
2. **GS character presence** — If decoded text contains `\x1D` (ASCII 29), FNC1 separators were encoded
3. **Symbology Identifier prefix** (if scanner provides it):
   - `]C1` = GS1-128 (Code 128 with FNC1 in first position)
   - `]e0` = GS1 DataBar
   - `]d2` = GS1 DataMatrix
   - `]Q3` = GS1 QR Code
   - `]C0` = Plain Code-128 → NOT GS1
4. **Heuristic fallback** — If no symbology info, try to parse as GS1. If it cleanly parses with valid AIs + correct lengths → "likely GS1". If not → "not GS1 or malformed"

### Parsing Flow
```
1. Receive decoded text + barcode format from ZXing
2. Determine GS1 confidence level (confirmed / likely / unlikely)
3. Strip symbology identifier prefix (if present)
4. Loop:
   a. Read 2-4 digit AI prefix (try longest match first: 4→3→2 digits)
   b. Look up AI definition (fixed vs variable length, data type, max length)
   c. For fixed-length AIs: read exactly N characters
   d. For variable-length AIs: read until GS character (\x1D) or end of string
   e. Validate extracted value against AI definition
   f. Store parsed element { ai, rawValue, label, valid, errors[] }
   g. Repeat until string exhausted or unrecognized prefix
5. Run business rule validation across all parsed elements
6. Return structured result with compliance verdict
```

### Validation Checks
| Check | Example |
|-------|---------|
| FNC1 present | String starts with `]C1` or equivalent |
| Valid AI code | AI exists in GS1 spec |
| Correct data length | AI `01` (GTIN) must be exactly 14 digits |
| Correct data type | Numeric-only AIs contain only digits |
| Check digit valid | GTIN-14, SSCC have check digit algorithms |
| GS separators present | Variable-length fields terminated before next AI |
| Date format valid | YYMMDD where MM=00 means unspecified, DD=00 means unspecified |
| Mandatory pairs | AI `02` (CONTENT) requires AI `37` (COUNT) |
| No duplicate AIs | Same AI shouldn't appear twice (with exceptions) |

### Best Practice Warnings (non-fatal)
- **AI `241` used instead of AI `01`** — Vendor should obtain a GTIN; using customer part number as primary ID is non-standard
- AI `01` (GTIN) without AI `10` (batch/lot) — common in pharma/food
- AI `01` without AI `17` (expiry) — regulated industries expect this
- AI `02` + `37` must not coexist with AI `00` in same barcode
- Using AI `15` (best before) AND AI `17` (expiry) — redundant, pick one
- Variable-length field at end of barcode missing GS (valid but fragile — reordering AIs would break it)
- AI `30` without AI `02` — count of what? Usually pairs with content GTIN

---

## Your Specific Vendor Issues (Detection Matrix)

| Problem | How We Detect It | Severity |
|---------|-----------------|----------|
| Plain Code-128 (no FNC1) | ZXing decodes as CODE_128, no GS chars found, no `]C1` prefix | ❌ Error |
| Missing Group Separators | Variable-length field runs into next AI, parsing fails or AI not found | ❌ Error |
| AI `241` as primary identifier (no GTIN) | AI `01` absent, AI `241` present | ⚠️ Warning |
| AI values wrong length | AI `01` value isn't exactly 14 digits | ❌ Error |
| AI values wrong type | Numeric AI contains alpha characters | ❌ Error |
| Invalid check digit | GTIN/SSCC check digit doesn't compute | ❌ Error |
| Date format invalid | YYMMDD with MM > 12 or DD > 31 | ❌ Error |
| AI `30` without context | Count present but no AI `02` to count | ⚠️ Warning |

---

## Application Identifier Data (Key Subset — Your AIs)

| AI | Name | Format | Fixed Length? | Notes |
|----|------|--------|--------------|-------|
| 00 | SSCC | N2+N18 | Yes (18) | Check digit (mod 10) |
| 01 | GTIN | N2+N14 | Yes (14) | Check digit (mod 10) |
| 02 | Content GTIN | N2+N14 | Yes (14) | Requires AI 37 |
| 10 | Batch/Lot | N2+X..20 | **No** (up to 20) | Needs GS terminator |
| 11 | Production Date | N2+N6 | Yes (6) | YYMMDD |
| 13 | Pack Date | N2+N6 | Yes (6) | YYMMDD |
| 15 | Best Before | N2+N6 | Yes (6) | YYMMDD |
| 17 | Expiry Date | N2+N6 | Yes (6) | YYMMDD |
| 21 | Serial Number | N2+X..20 | **No** (up to 20) | Needs GS terminator |
| 30 | Variable Count | N2+N..8 | **No** (up to 8) | Needs GS terminator |
| 37 | Count of Items | N2+N..8 | **No** (up to 8) | Needs GS terminator |
| 241 | Customer Part No | N3+X..30 | **No** (up to 30) | Your item ID substitute |
| 310n | Net Weight kg | N4+N6 | Yes (6) | n = decimal position |
| 320n | Net Weight lb | N4+N6 | Yes (6) | n = decimal position |

**Critical insight for your use case:** AIs `10`, `21`, `30`, `37`, and `241` are all **variable-length** — these are the ones where missing GS separators cause parsing failures. Fixed-length AIs (01, 17, 15, 310n, 320n) self-terminate so they're less error-prone.

---

## GS1 Open-Source Landscape

| Resource | Language | Notes |
|----------|----------|-------|
| GS1 Syntax Engine | C | Official reference implementation — validates syntax. Not usable in browser. |
| ZXing-js | TypeScript | Barcode *scanning* (camera→decoded text). Supports Code128, DataMatrix, QR. **Can detect GS1 mode.** |
| gs1js (npm) | JavaScript | Lightweight AI parser — good reference for AI definitions |
| GS1 Digital Link Toolkit | JavaScript | Official GS1, focused on URI translation not raw barcode parsing |

**Our approach:** Use ZXing-js for scanning + write our own GS1 parser in TypeScript. The parser is actually not that complex — it's a lookup table + a state machine. The hard part is the validation rules and edge cases, which we define based on our specific needs.

---

## Tech Stack

```
React 18+          — UI framework
TypeScript         — All logic
Vite               — Build tool
Tailwind CSS       — Styling
ZXing-js           — Camera barcode scanning (browser-based)
@microsoft/power-apps — Power Platform SDK (auth, hosting)
```

### Project Scaffold
```
npx degit microsoft/PowerAppsCodeApps/templates/starter gs1-parser
cd gs1-parser
npm install
npm install @nickvdyck/zxing-browser  (or @nickvdyck/zxing-wasm)
npm run dev
```

---

## UI Mockup (PCF Component Output)

```
┌──────────────────────────────────────────────────────────┐
│  📊 GS1 Barcode Analysis                                │
├──────────────────────────────────────────────────────────┤
│  Status: ✅ VALID GS1-128 Barcode                       │
│  Symbology: GS1-128 (Code 128 with FNC1)                │
│                                                          │
│  ┌─ Parsed Elements ──────────────────────────────────┐  │
│  │ AI 01  GTIN           00614141123452              │  │
│  │ AI 17  Expiry Date    2025-12-31                  │  │
│  │ AI 10  Batch/Lot      ABC123                      │  │
│  │ AI 21  Serial         XYZ789                      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ⚠️  Warnings:                                           │
│  • AI 01 check digit: VALID                             │
│  • Consider adding AI 30 (count) for logistics units    │
│                                                          │
│  ❌ Errors: None                                         │
└──────────────────────────────────────────────────────────┘
```

**Non-compliant example:**
```
┌──────────────────────────────────────────────────────────┐
│  📊 GS1 Barcode Analysis                                │
├──────────────────────────────────────────────────────────┤
│  Status: ❌ NOT a GS1 Barcode                           │
│  Symbology: Standard Code-128 (no FNC1)                 │
│                                                          │
│  Raw Data: "0100614141123452172512311..."                │
│                                                          │
│  ❌ Errors:                                              │
│  • Missing FNC1 start character — this is a plain       │
│    Code-128, not GS1-128                                │
│  • Cannot reliably parse AIs without FNC1 context       │
│                                                          │
│  💡 Attempted Parse (best-effort):                       │
│  │ AI 01?  GTIN?         00614141123452              │  │
│  │ AI 17?  Expiry?       251231                      │  │
│                                                          │
│  📋 Vendor Action Required:                              │
│  • Barcode must use GS1-128 symbology (FNC1 in pos 1)  │
│  • Request vendor update label template                  │
└──────────────────────────────────────────────────────────┘
```

---

## Development Plan

### Phase 1: GS1 Parser Library (Pure TypeScript — no UI)
1. Define AI lookup table with format, length, type, check digit rules
2. Implement AI prefix matching (longest-match-first: 4→3→2 digits)
3. Implement fixed vs variable-length field extraction
4. Implement GS character handling for variable-length fields
5. Implement validators: check digits, date format, data types
6. Implement business rules (mandatory pairs, your specific warnings)
7. Unit test with known-good and known-bad barcode strings

### Phase 2: Barcode Scanner + UI (React)
1. Scaffold Code App from starter template
2. Integrate ZXing-js for camera-based scanning
3. Build scanner view (camera feed, scan button, flash toggle)
4. Build results view (compliance status, parsed AI table, errors/warnings)
5. Wire scanner output → parser → results display
6. Test on phone browser with real labels

### Phase 3: Deploy to Power Platform
1. Configure `power.config.json`
2. `pac code push` to environment
3. Share with receiving team users
4. Iterate on feedback (add AIs, tune warnings)

### Optional Enhancements
- Manual text input mode (paste barcode data from clipboard)
- "Copy report" button to share with vendor as evidence of non-compliance
- Dark mode for warehouse environments
- Sound/haptic feedback on scan success/failure

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Platform | Power Apps Code App | Full code control, React/TS, hosted in Power Platform, users have licenses |
| Scanner library | ZXing-js (browser WASM) | Supports Code128/DataMatrix/QR, can detect GS1 mode, outputs GS chars |
| Parser | Custom TypeScript | ~300-500 lines for our subset of AIs; no suitable npm package handles validation |
| AI definitions | Embedded TypeScript map | Static data, rarely changes, no need for external fetch |
| UI framework | React + Tailwind | Ships with the Code Apps starter template |
| Offline | Yes by default | All logic is client-side, no server calls needed for parsing |

---

## Open Questions / Risks

1. **ZXing-js GS1 mode fidelity** — Need to validate that ZXing actually passes through GS characters (`\x1D`) for Code128 GS1 mode. If it doesn't, we're in the same boat as the canvas app scanner. *Mitigation: test with a known GS1-128 barcode early in Phase 2.*

2. **Camera performance on labels** — Phone cameras through a browser may struggle with small/dense barcodes on real labels (especially DataMatrix). *Mitigation: ZXing WASM version is faster than the pure JS version. Also consider torch/flash API for dark warehouses.*

3. **Code Apps maturity** — It's GA but relatively new. Edge cases in deployment or browser compatibility could surface. *Mitigation: it's fundamentally just a React SPA — worst case we deploy as a standalone web app without the Power Platform wrapper.*

4. **FNC1 detection for already-scanned data** — If users are pasting text from a different scanner (Bluetooth keyboard scanner), we won't have FNC1 info. *Mitigation: offer "best effort" mode that attempts to parse without FNC1 confirmation and flags uncertainty.*
