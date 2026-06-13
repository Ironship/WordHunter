# Word Hunter - build

Masz teraz dwa glowne entrypointy:

- Windows CMD/PowerShell: `build.bat`
- Bash/WSL/Git Bash: `./build.sh`

Nie trzeba zgadywac skryptow typu `build_cython.py`.

## 1. Windows CMD

Prompt wyglada tak:

```bat
C:\Users\Oleg\Desktop\WordHunter-Release>
```

Komendy:

```bat
cd /d C:\Users\Oleg\Desktop\WordHunter-Release
build.bat
```

Skrypt pokaze menu:

```text
W  Windows .exe with Cython
L  Linux executable through WSL
Q  Quit
```

Bez menu:

```bat
build.bat windows
build.bat linux
```

## 2. PowerShell

Prompt wyglada tak:

```powershell
PS C:\Users\Oleg\Desktop\WordHunter-Release>
```

Komendy:

```powershell
cd C:\Users\Oleg\Desktop\WordHunter-Release
.\build.bat
```

Bez menu:

```powershell
.\build.bat windows
.\build.bat linux
```

## 3. WSL / Ubuntu / Debian

Prompt wyglada mniej wiecej tak:

```sh
test@DESKTOP:/mnt/c/Users/Oleg/Desktop/WordHunter-Release$
```

Komendy:

```sh
cd /mnt/c/Users/Oleg/Desktop/WordHunter-Release
./build.sh
```

W WSL domyslnie buduje sie Linux:

```text
output/Word.Hunter.Linux
```

Windows `.exe` z WSL:

```sh
./build.sh windows
```

To tylko przekazuje prace do Windowsowego `build_cython.bat`, wiec Windows nadal musi miec Python i MSVC.

## 4. Git Bash / MINGW64

Prompt wyglada tak:

```sh
Oleg@DESKTOP-... MINGW64 ~
```

W Git Bash NIE wpisuj:

```sh
cd C:\Users\Oleg\Desktop\WordHunter-Release
```

Bash zje backslashe i zrobi z tego `C:UsersOlegDesktop...`.

Poprawnie:

```sh
cd /c/Users/Oleg/Desktop/WordHunter-Release
./build.sh
```

`./build.sh` wykryje Git Bash i odpali Windowsowe menu `build.bat`.

Bez menu:

```sh
./build.sh windows
./build.sh linux
```

## Wyniki

Windows:

```text
output\Word.Hunter.exe
```

Linux:

```text
output\Word.Hunter.Linux
```

Jesli Linux build konczy sie tak:

```text
Done: /mnt/c/Users/Oleg/Desktop/WordHunter-Release/output/Word.Hunter.Linux
```

to build sie udal.

## Wymagania Windows `.exe` z Cythonem

Do Windows `.exe` z Cythonem potrzebny jest:

- Windows Python 3,
- Visual Studio Build Tools z workloadem `Desktop development with C++`.

Sprawdzenie Pythona:

```bat
py -3 --version
```

Jesli brakuje MSVC, `build_cython.bat` zapyta, czy zainstalowac Visual Studio Build Tools przez `winget`.

Ręczna instalacja:

```bat
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Po instalacji otworz nowy terminal i uruchom build jeszcze raz.

## Wymagania Linux / WSL

Jesli w WSL brakuje narzedzi Pythona:

```sh
sudo apt update
sudo apt install -y python3 python3-venv python3-pip
```

Jesli wynikowy Linux program nie otwiera okna, doinstaluj typowe biblioteki Qt:

```sh
sudo apt update
sudo apt install -y libxcb-cursor0 libxcb-image0 libxcb-icccm4 libxcb-keysyms1 libxcb-render-util0 libxcb-xkb1 libxcb-util1 libxkbcommon-x11-0
```

## Logi

Linux build nie zalewa juz terminala setkami linii PyInstallera.
Szczegolowy log jest tutaj:

```text
build/logs/linux-build.log
```

Jesli build padnie, skrypt pokaze ostatnie linie tego loga.

## Czyszczenie

Bezpiecznie mozna usunac:

```text
build/
output/
.venv-linux/
```

Po usunieciu `.venv-linux` kolejny Linux build odtworzy virtualenv od zera.
