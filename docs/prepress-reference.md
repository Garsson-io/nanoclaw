# Prepress PDF Reference

Technical reference for prepress PDF handling in NanoClaw container agents.

## PDF Box Model

Every PDF page has up to 5 boundary boxes (only MediaBox is required):

```
MediaBox (outermost — physical media)
  CropBox (viewer display area, defaults to MediaBox)
    BleedBox (content to keep during production, extends past trim)
      TrimBox (final page size after cutting)
        ArtBox (meaningful content area)
```

### Measurements

| Unit | Conversion |
|------|-----------|
| 1 PDF point | 1/72 inch = 0.353mm |
| 1mm | 2.835 pt |
| 3mm (standard bleed) | 8.504 pt |
| 1/8 inch | 9 pt |

### Standard Paper Sizes (points)

| Size | Width | Height |
|------|-------|--------|
| A3 | 841.89 | 1190.55 |
| A4 | 595.28 | 841.89 |
| A5 | 419.53 | 595.28 |
| Letter | 612 | 792 |
| Legal | 612 | 1008 |
| Tabloid | 792 | 1224 |

## Bleed Detection Strategies

### 1. Explicit boxes (high confidence)
When both TrimBox and BleedBox are defined:
```
bleed_left = TrimBox.x0 - BleedBox.x0
bleed_right = BleedBox.x1 - TrimBox.x1
```

### 2. TrimBox + ink analysis (medium confidence)
When TrimBox exists but BleedBox doesn't:
- Use `gs -sDEVICE=bbox` to find actual ink bounding box
- Measure ink extent beyond TrimBox on each side
- If ink extends past TrimBox, bleed content exists

### 3. Standard size matching (medium confidence)
When only MediaBox exists:
- Compare to standard paper sizes
- If MediaBox = standard_size + ~3mm per side, infer TrimBox at standard size
- Verify with ink analysis

### 4. Edge pixel sampling (low confidence)
Last resort — render and check for non-white pixels at page edges:
- Render at 72-150 DPI with Ghostscript
- Sample pixels along each edge
- If >5% non-white, content reaches that edge

## Preflight Checklist

### Critical (must fix)
- TrimBox defined
- BleedBox defined (or bleed inferable)
- Bleed >= 2mm on all sides (3mm preferred)
- All fonts embedded
- No missing fonts

### Warnings (should fix)
- RGB images (convert to CMYK for offset)
- Low resolution images (<300 DPI at print size)
- No PDF/X conformance declared

### For reference
- Total ink coverage: <= 300% (safe default), <= 320% (sheetfed offset)
- White objects with overprint (they disappear in print)
- Transparency compatibility with target RIP

## Tools Available in Container

| Tool | Package | Use For |
|------|---------|---------|
| `gs` (Ghostscript) | ghostscript | Rendering, bbox detection, ink coverage, PS/PDF conversion, PDF/X |
| `pdfinfo` | poppler-utils | Quick metadata and box inspection |
| `pdftotext` | poppler-utils | Text extraction |
| `pikepdf` | pip: pikepdf | Reading/writing page boxes, image analysis, PDF repair |
| `pymupdf` (fitz) | pip: pymupdf | Font analysis, rendering, text extraction |
| `Pillow` | pip: Pillow | Image processing, edge pixel analysis |

## Common Operations

### PS to PDF
```bash
gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile=output.pdf input.ps
```

### Set TrimBox + BleedBox
```python
import pikepdf
pdf = pikepdf.Pdf.open('input.pdf')
for page in pdf.pages:
    mb = [float(v) for v in page.mediabox]
    bleed_mm = 3
    bleed_pt = bleed_mm * 2.835
    page.trimbox = pikepdf.Array([
        mb[0] + bleed_pt, mb[1] + bleed_pt,
        mb[2] - bleed_pt, mb[3] - bleed_pt
    ])
    page.bleedbox = pikepdf.Array(mb)  # BleedBox = MediaBox
pdf.save('output.pdf')
```

### Check ink coverage (TAC)
```bash
gs -dSAFER -dBATCH -dNOPAUSE -o- -sDEVICE=ink_cov input.pdf
```

### Render page for visual inspection
```bash
gs -dSAFER -dBATCH -dNOPAUSE -sDEVICE=png16m -r300 \
   -dFirstPage=1 -dLastPage=1 -sOutputFile=page1.png input.pdf
```
