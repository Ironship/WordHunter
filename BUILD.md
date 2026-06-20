# Word Hunter Rustified build

Jest jeden Windowsowy skrypt buildowy:

```powershell
.\build.bat
```

Domyslnie buduje instalator Windows:

```text
outputs\Word.Hunter.Setup.exe
```

## Komendy

```powershell
.\build.bat              # instalator NSIS
.\build.bat all          # instalator NSIS
.\build.bat installer    # instalator NSIS
.\build.bat ocr-runtime  # pobierz modele, pdfium.dll i zbuduj runner OCR
.\build.bat exe          # alias Rust/Tauri exe
.\build.bat rust         # Rust/Tauri exe
.\build.bat flatpak      # target do dokonczenia na Linux/WSL
.\build.bat dmg          # target macOS-only
.\build.bat help
```

## Wymagania Windows

Potrzebne sa:

- Rust/Cargo,
- Tauri CLI (`cargo install tauri-cli --locked`),
- Visual Studio Build Tools / MSVC z workloadem `Desktop development with C++`,
- WebView2 Runtime.

Skrypt sam laduje MSVC i buduje release przez Tauri. Dla stabilnosci CMake/RUY
ustawia `CMAKE_BUILD_PARALLEL_LEVEL=1`, jesli ta zmienna nie byla ustawiona
wczesniej.

Instalator NSIS jest skonfigurowany jako `perMachine`, wiec instaluje aplikacje
do `Program Files`. Na pulpicie zostaje tylko skrot.

## Tlumacz offline

Tlumaczenie offline dziala przez natywny CTranslate2 CPU-only:

- modele SentencePiece sa obslugiwane natywnie,
- modele BPE sa obslugiwane natywnym tokenizerem Rust,
- instalacja modeli pobiera kompatybilny indeks pakietów offline i rozpakowuje `.argosmodel` w Rust.

Modele i dane uzytkownika trafiaja do:

```text
%APPDATA%\WordHunter\
%APPDATA%\WordHunter\argos-packages\
```

Dla migracji Rustified potrafi tez czytac istniejace modele z:

```text
%USERPROFILE%\.local\share\argos-translate\packages\
```

## PDF OCR

Eksperymentalny import PDF OCR uzywa lokalnego, natywnego runnera PaddleOCR.
Word Hunter nie wymaga Pythona. Runtime nalezy umiescic w:

```text
src-tauri\ocr-runtime\
```

Skrypt buildowy przygotowuje runtime automatycznie przed budowa instalatora.
Mozna go tez uruchomic osobno:

```powershell
.\build.bat ocr-runtime
```

Wygenerowane binaria OCR, `pdfium.dll` i modele `.onnx` sa celowo ignorowane
przez Git. Do repo trafia kod runnera i skrypt przygotowania runtime'u, a
instalator dostaje lokalnie odtworzone pliki z `src-tauri\ocr-runtime`.

Finalny uklad:

```text
src-tauri\ocr-runtime\bin\wordhunter-paddleocr.exe
src-tauri\ocr-runtime\bin\pdfium.dll
src-tauri\ocr-runtime\bin\onnxruntime.dll
src-tauri\ocr-runtime\models\*.onnx
```

Folder `ocr-runtime` jest bundlowany przez Tauri do instalatora i trafia do
zasobow aplikacji pod `Program Files`. Backend wywoluje runnera z argumentami
opisanymi w `src-tauri\ocr-runtime\README.md`.

## Flatpak i DMG

Flatpak trzeba dokonczyc jako Linuxowy build Rust/Tauri. DMG musi byc budowany
na macOS albo w CI z runnerem macOS.

## Czyszczenie

Bezpiecznie mozna usunac:

```text
build\
outputs\
src-tauri\target\
src-tauri\ocr-runner\target\
```
