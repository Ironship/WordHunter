# PDF OCR native runtime

PDF OCR uses a bundled native PaddleOCR runner. No Python runtime is required by
Word Hunter.

The build script prepares this automatically for `portable`, `installer`, and
`all`. Run it manually only when refreshing the OCR runtime:

```powershell
.\src-tauri\ocr-runtime\prepare-runtime.ps1
```

It downloads PaddleOCR ONNX models, downloads `pdfium.dll`, builds the native
Rust runner, and copies the executable and DLLs into this runtime folder.
The bundled defaults are the small PP-OCRv5 ONNX models used by
`paddle-ocr-rs`. Language-specific PP-OCR ONNX models can be dropped into
`models\` as `det.onnx`, `rec.onnx`, and `dict.txt` without changing the app.

Expected Windows layout:

```text
src-tauri\ocr-runtime\
  bin\wordhunter-paddleocr.exe
  bin\*.dll
  models\...
  models\*.onnx
```

The runner must render PDF pages to images, run PaddleOCR locally, and write a
JSON manifest. Word Hunter calls it with:

```text
wordhunter-paddleocr.exe --input input.pdf --output-dir pages --json ocr.json --lang pl --max-pages 0
```

`--max-pages 0` processes the whole PDF.

Expected JSON shape:

```json
{
  "pageCount": 12,
  "truncated": false,
  "ocrEngine": "paddleocr-rs-onnx",
  "pages": [
    {
      "page": 1,
      "imageName": "pdf-page-0001.png",
      "width": 1200,
      "height": 1700,
      "text": "recognized page text",
      "words": [
        { "text": "word", "x": 10, "y": 20, "width": 40, "height": 16, "confidence": 0.98 }
      ]
    }
  ]
}
```

`imageName` must be a plain file name produced inside `--output-dir`.
Coordinates are in rendered image pixels. PaddleOCR returns line boxes; the
runner also emits approximate word boxes so Word Hunter can keep per-word
lookup interactions.
