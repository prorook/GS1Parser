# GS1 Barcode Parser

A browser-based GS1 barcode scanner and parser. Scan barcodes with your camera or enter data manually to decode GS1 Application Identifiers (AIs).

**Live:** [https://prorook.github.io/GS1Parser/](https://prorook.github.io/GS1Parser/)

## Features

- **Camera scanning** — Reads GS1-128, DataMatrix, QR Code, DataBar, EAN-13/8, and ITF-14 barcodes in real time
- **Manual input** — Paste or type bracketed AI format (e.g. `(01)00614141123452(17)260531`) or raw scan data
- **AI decoding** — Parses all GS1 Application Identifiers with human-readable labels
- **Validation** — Check digit verification, AI association checks, and FNC1 compliance detection
- **Confidence scoring** — Distinguishes confirmed GS1, likely GS1 (missing FNC1), and non-GS1 barcodes
- **Offline** — Runs entirely in the browser with no backend

## Tech Stack

- React 19 + TypeScript
- Vite
- Tailwind CSS
- [zxing-wasm](https://github.com/niccolopaganini/niccolopaganini) — barcode reading via WebAssembly
- [gs1encoder](https://github.com/gs1/gs1-syntax-engine) — GS1 syntax validation via WebAssembly

## Development

```bash
npm install
npm run dev      # starts dev server with HTTPS (required for camera access)
npm run build    # production build to dist/
npm test         # run tests
```

## Supported Symbologies

| Symbology | AIM ID | GS1 Status |
|-----------|--------|------------|
| GS1-128 | `]C1` | Confirmed |
| GS1 DataMatrix | `]d2` | Confirmed |
| GS1 QR Code | `]Q3` | Confirmed |
| GS1 DataBar | `]e0`–`]e3` | Confirmed |
| ITF-14 | `]I1` | Confirmed (GTIN-14 only) |
| Code-128 (no FNC1) | `]C0` | Likely |
| DataMatrix (no FNC1) | `]d1` | Likely |
| QR Code (no FNC1) | `]Q1` | Likely |

## License

MIT
