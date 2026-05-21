# GS1 Barcode Auditor

A browser-based tool for auditing whether **vendor-supplied barcodes are actually compliant GS1 labels** — not just decoding the data, but spotting the common ways suppliers ship labels that *look* like GS1 but aren't.

**Live:** [https://prorook.github.io/GS1Parser/](https://prorook.github.io/GS1Parser/)

## What it's for

Vendors are supposed to ship labels encoded as proper GS1 barcodes (GS1-128, GS1 DataMatrix, GS1 QR, etc.). In practice they often ship something close but wrong — and the data still scans, so the problem goes unnoticed until it breaks something downstream.

Point the scanner at a label and the tool tells you:

- **What symbology it actually is** (via AIM ID, not just barcode format), so a Code-128 mis-labelled as GS1-128 doesn't slip through.
- **Whether it's a real, compliant GS1 barcode**, or just contains GS1-shaped data in a non-GS1 carrier.
- **What's broken**, when something is — with a vendor-actionable error message.

### Compliance issues it detects

| Issue | What's actually happening |
|---|---|
| Missing FNC1 | Data looks like GS1 AIs but the barcode wasn't encoded as GS1 (e.g. `]C0` instead of `]C1`). |
| Wrong group separator character | Label software emitted `%`, `~`, or `\|` where ASCII 29 (FNC1) should be. |
| Bracketed HRI as data | The barcode literally encodes the human-readable text `(01)…(10)…` — parentheses aren't supposed to be in the barcode. |
| Bad check digit | GTIN-14 / SSCC / GLN check digit doesn't validate. |
| Bad AI associations | Combinations gs1encoder considers invalid (e.g. mandatory AIs missing). |
| False-positive GS1 | A single-AI parse on a non-GS1 barcode that's probably a coincidence (e.g. random digits matching AI 240). |

## Scanner features

- **Camera scanning** with real-time recognition of GS1-128, GS1 DataMatrix, GS1 QR, GS1 DataBar, EAN-13/8, ITF-14, and their non-GS1 cousins.
- **Aim overlay** with three modes (toggle in-app):
  - **1D** — horizontal strip for long dense GS1-128 / DataBar / EAN / ITF labels.
  - **2D** — centered square for QR Code / DataMatrix.
  - **Full** — no clipping, for awkward sizes like GS1 DataBar Stacked.
  - The toggle persists across sessions.
- **Flashlight toggle** when the camera supports torch mode (most Android Chrome).
- **Manual input** — paste bracketed AI format (`(01)00614141123452(17)260531`) or raw scan data; useful for testing without a printed label.

## Compliance / privacy

- Runs **entirely client-side** — no scan data leaves the browser.
- WASM runtimes (`zxing-wasm` and `gs1encoder`) are bundled into the deployed assets, not fetched from a CDN at runtime.
- Strict CSP with `default-src 'self'`, `frame-ancestors 'none'`, `connect-src 'self'`, plus a `Permissions-Policy` that limits API access to camera-only.

## Supported symbologies

| Symbology | AIM ID | GS1 status |
|-----------|--------|------------|
| GS1-128 | `]C1` | Confirmed |
| GS1 DataMatrix | `]d2` | Confirmed |
| GS1 QR Code | `]Q3` | Confirmed |
| GS1 DataBar (all variants) | `]e0`–`]e3` | Confirmed |
| ITF-14 | `]I1` | Confirmed (GTIN-14 only) |
| GS1 Digital Link URI | (in `]Q1`) | Confirmed |
| Code-128 (no FNC1) | `]C0` | Likely — flagged with vendor-actionable warning |
| DataMatrix (no FNC1) | `]d1` | Likely — flagged with vendor-actionable warning |
| QR Code (no FNC1) | `]Q1` | Likely — flagged with vendor-actionable warning |

## Tech stack

- React 19 + TypeScript
- Vite + Tailwind CSS
- [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) — barcode reading via WebAssembly
- [gs1encoder](https://github.com/gs1/gs1-syntax-engine) — GS1 syntax validation via WebAssembly

## Development

```bash
npm install
npm run dev      # starts dev server with HTTPS (required for camera access)
npm run build    # production build to dist/
npm test         # run tests
```

Deployment is automatic via GitHub Actions on push to `main` (see `.github/workflows/deploy.yml`).

Append `?debug=1` to the URL in dev mode for verbose console logs from the parser internals.

## License

MIT
