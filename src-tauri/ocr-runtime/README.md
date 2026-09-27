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
`paddle-ocr-rs`, which read Chinese, English and Japanese. Other models can be
dropped into `models\` without changing the app. The runner picks the
recognizer and its dictionary together, for the learning language it is given
(`--lang`), in this order:

1. `<lang>_rec.onnx` with `<lang>_dict.txt` (for example `de_rec.onnx`);
2. `rec.onnx` with `dict.txt`;
3. PaddleOCR's PP-OCRv5 model for the language's script:
   `<family>_PP-OCRv5_mobile_rec_infer.onnx` (or `<family>_rec.onnx`) with
   `<family>_dict.txt`, where the family is `latin` (German, Polish, French,
   Spanish, Italian and other Latin-script languages), `eslav` (Russian,
   Ukrainian, Belarusian), `cyrillic`, `el`, `arabic`, `devanagari`,
   `korean` or `th`;
4. the bundled Chinese/English model; for a language with a family above it
   prints a warning, because it may drop that language's letters.

A recognizer is only ever paired with its own dictionary file. Without one it
must carry its character list in its ONNX metadata (`character`, as the
RapidOCR/paddle-ocr-rs exports do); otherwise the runner skips it and tries
the next. Dictionary files can use PaddleOCR's own format (one character per
line) or already include the CTC blank as the first line and a space as the
last: the runner compares the line count with the model's number of output
classes and adds the blank and the space when they are missing. A dictionary
whose size fits neither belongs to another model, and the recognizer is
skipped.

`det.onnx` and `cls.onnx` replace the bundled detection and orientation
models.

Expected Windows layout:

```text
src-tauri\ocr-runtime\
  bin\wordhunter-paddleocr.exe
  bin\*.dll
  bin\libstdc++-6.dll when the runner imports the GNU runtime
  bin\libgcc_s_seh-1.dll and bin\libwinpthread-1.dll when provided by the same toolchain
  models\...
  models\*.onnx
```

The desktop app executable can also import GNU runtime DLLs depending on the
Windows Rust target used for the release build. `scripts\build.bat` copies those
DLLs next to `Word.Hunter.portable.exe` and stages them next to the Tauri binary
before the NSIS installer is bundled. When those DLLs are required, the build
also passes a generated Tauri config so NSIS installs them beside the main EXE.

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
  "ocrEngine": "pdfium-text-layer+paddleocr-rs-onnx",
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
