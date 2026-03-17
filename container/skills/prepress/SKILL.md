---
name: prepress
description: Analyze PDFs for print-readiness — detect bleeds, inspect page boxes, run preflight checks. Use whenever handling PDFs destined for professional printing.
allowed-tools: Bash(prepress:*)
---

# Prepress PDF Analysis

Analyze PDFs for print-readiness: bleed detection, page box inspection, and preflight checks.

## Quick start

```bash
prepress inspect file.pdf      # Show all page boxes and dimensions
prepress bleed file.pdf        # Detect and measure bleeds
prepress preflight file.pdf    # Full preflight check
```

## Commands

### inspect — Page box analysis

Shows all 5 PDF boxes (MediaBox, CropBox, BleedBox, TrimBox, ArtBox) per page, whether each is explicitly defined or inherited, dimensions in mm, and standard size matching.

```bash
prepress inspect input.pdf
```

### bleed — Bleed detection

Multi-strategy bleed detection with confidence levels:

| Strategy | When used | Confidence |
|----------|-----------|------------|
| Explicit boxes | TrimBox + BleedBox both defined | High |
| TrimBox + ink extent | TrimBox defined, uses Ghostscript bbox to find ink | Medium |
| Standard size matching | No TrimBox, MediaBox matches standard size + bleed margin | Medium |
| Edge content analysis | No boxes, renders page and checks for content at edges | Low |

Verdicts: **good** (>=3mm), **acceptable** (>=2mm), **marginal** (>=1mm), **insufficient** (<1mm), **none**

```bash
prepress bleed input.pdf
```

### preflight — Print-readiness check

Checks:
- Page boxes: TrimBox/BleedBox presence, bleed adequacy
- Images: color space (RGB vs CMYK), resolution
- Fonts: embedded vs missing
- Reports issues (must fix), warnings (should fix), and info

```bash
prepress preflight input.pdf
```

## Prepress concepts

### PDF page boxes

| Box | Purpose | Required? |
|-----|---------|-----------|
| MediaBox | Physical page size (always present) | Yes |
| CropBox | Viewer display area (defaults to MediaBox) | No |
| BleedBox | Bleed extent — content past trim for cutting tolerance | No (required by PDF/X) |
| TrimBox | Final trimmed page size — what the customer receives | No (required by PDF/X) |
| ArtBox | Meaningful content area | No |

Hierarchy: MediaBox >= CropBox >= BleedBox >= TrimBox >= ArtBox

### Bleed

Extra content extending past the trim line (usually 3mm/0.125") so there's no white edge after cutting. A properly set up print PDF has:
- TrimBox = final page size
- BleedBox = TrimBox + 3mm on each side
- MediaBox >= BleedBox
- Content (backgrounds, images) extending to at least the BleedBox edge

### Standard bleed sizes

| Standard | Size |
|----------|------|
| Industry standard | 3mm (8.5pt, 1/8") |
| Minimum acceptable | 2mm (5.7pt) |
| Large format | 5-6mm |

## Advanced usage with underlying tools

For tasks beyond what this tool covers, the container has:

```bash
# Ghostscript — rendering, color conversion, PDF/X
gs -dSAFER -dBATCH -dNOPAUSE -sDEVICE=bbox input.pdf        # Find ink extent
gs -dSAFER -dBATCH -dNOPAUSE -o- -sDEVICE=inkcov input.pdf  # Ink coverage

# Poppler — text extraction, page info
pdfinfo input.pdf          # Basic metadata
pdfinfo -box input.pdf     # Show all page boxes
pdftotext input.pdf -      # Extract text

# Python — pikepdf, pymupdf, Pillow
python3 -c "
import pikepdf
pdf = pikepdf.Pdf.open('input.pdf')
page = pdf.pages[0]
print('TrimBox:', page.trimbox if '/TrimBox' in page else 'not set')
print('BleedBox:', page.bleedbox if '/BleedBox' in page else 'not set')
"
```
