#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Word.Hunter"
LINUX_NAME="Word.Hunter.Linux"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$ROOT_DIR/src"
VENV_DIR="$ROOT_DIR/.venv-linux"
OUTPUT_DIR="$ROOT_DIR/output"
BUILD_DIR="$ROOT_DIR/build/linux"
LOG_DIR="$ROOT_DIR/build/logs"
LOG_FILE="$LOG_DIR/linux-build.log"
SYSTEM_NAME="$(uname -s 2>/dev/null || echo unknown)"

usage() {
    cat <<USAGE
Usage:
  ./build.sh [linux]
  ./build.sh windows

Targets:
  linux           Build a Linux executable in WSL with PyInstaller.
  windows         Start the Windows Cython .exe build through build_cython.bat.

Shell behavior:
  WSL/Linux       default target is linux.
  Git Bash/MINGW  default target opens build.bat menu.
USAGE
}

is_windows_bash() {
    [[ "$SYSTEM_NAME" == MINGW* || "$SYSTEM_NAME" == MSYS* || "$SYSTEM_NAME" == CYGWIN* ]]
}

run_windows_batch() {
    local script="$1"
    need_cmd cmd.exe

    local batch_path="$ROOT_DIR/$script"
    if command -v cygpath >/dev/null 2>&1; then
        batch_path="$(cygpath -w "$batch_path")"
    fi

    cmd.exe //c call "$batch_path"
}

need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing command: $1" >&2
        exit 1
    fi
}

install_python_deps() {
    "$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip setuptools wheel pyinstaller
    "$VENV_DIR/bin/python" -m pip install --quiet --upgrade -r "$SRC_DIR/requirements.txt"
}

build_linux() {
    need_cmd python3

    if [[ ! -d "$VENV_DIR" ]]; then
        python3 -m venv "$VENV_DIR"
    fi

    install_python_deps
    mkdir -p "$OUTPUT_DIR" "$BUILD_DIR" "$LOG_DIR"

    echo "Building Linux executable. Detailed log:"
    echo "  $LOG_FILE"
    echo "This can take several minutes. Leave this terminal open."
    echo

    if ! "$VENV_DIR/bin/python" -m PyInstaller \
            --log-level=WARN \
            --clean \
            --onefile \
            --noconsole \
            --name "$LINUX_NAME" \
            --add-data "$SRC_DIR/web:web" \
            --add-data "$SRC_DIR/wordhunter/assets:wordhunter/assets" \
            --distpath "$OUTPUT_DIR" \
            --workpath "$BUILD_DIR" \
            --specpath "$BUILD_DIR" \
            --noconfirm \
            "$SRC_DIR/run.py" >"$LOG_FILE" 2>&1; then
        echo "Linux build failed. Last log lines:"
        echo
        tail -n 120 "$LOG_FILE" || true
        exit 1
    fi

    if grep -q "Library not found" "$LOG_FILE"; then
        echo "Build finished, but PyInstaller reported missing Qt runtime libraries."
        echo "If the Linux app does not open, install the Qt/xcb packages listed in BUILD.md."
        echo
    fi

    echo
    echo "Done: $OUTPUT_DIR/$LINUX_NAME"
}

build_windows_cython() {
    need_cmd cmd.exe
    need_cmd wslpath

    local bat_path
    bat_path="$(wslpath -w "$ROOT_DIR/build_cython.bat")"
    cmd.exe /c "\"$bat_path\""
}

target="${1:-linux}"
if [[ $# -eq 0 ]] && is_windows_bash; then
    run_windows_batch "build.bat"
    exit $?
fi

case "$target" in
    linux)
        if is_windows_bash; then
            run_windows_batch "build_linux_wsl.bat"
        else
            build_linux
        fi
        ;;
    windows-cython|win|windows)
        if is_windows_bash; then
            run_windows_batch "build_cython.bat"
        else
            build_windows_cython
        fi
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo "Unknown target: $target" >&2
        usage
        exit 2
        ;;
esac
