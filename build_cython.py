#!/usr/bin/env python3
"""
Windows release build:
  1. copy src/ into build/cython-windows/src/
  2. compile Python application modules to .pyd with Cython
  3. remove Python sources from the build copy
  4. bundle the compiled app with PyInstaller
"""

from __future__ import annotations

import ast
import shutil
import subprocess
import sys
from pathlib import Path

APP_NAME = "Word.Hunter"
ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
BUILD_ROOT = ROOT / "build" / "cython-windows"
WORK_SRC = BUILD_ROOT / "src"
OUTPUT = ROOT / "output"

def _discover_cython_modules() -> dict[str, Path]:
    modules: dict[str, Path] = {}
    pkg_dir = SRC / "wordhunter"
    for py_file in sorted(pkg_dir.glob("*.py")):
        if py_file.name == "__init__.py":
            continue
        module_name = f"wordhunter.{py_file.stem}"
        rel_path = Path("wordhunter") / py_file.name
        modules[module_name] = rel_path
    return modules

CYTHON_MODULES = _discover_cython_modules()

BASE_HIDDEN_IMPORTS = [
    "wordhunter",
    "PySide6",
    "PySide6.QtCore",
    "PySide6.QtGui",
    "PySide6.QtWidgets",
    "PySide6.QtWebEngineCore",
    "PySide6.QtWebEngineWidgets",
    "edge_tts",
    "requests",
    "json",
    "os",
    "sqlite3",
    "sqlite3.dbapi2",
    "threading",
    "shutil",
    "pathlib",
    "typing",
    "http",
    "http.server",
    "socket",
    "socketserver",
    "subprocess",
    "queue",
    "urllib",
    "urllib.parse",
    "urllib.request",
    "secrets",
    "asyncio",
    "webbrowser",
    "base64",
]

COLLECT_ALL = [
    "edge_tts",
]

EXCLUDED_MODULES = [
    # stanza + its deps — replaced by our stub + minisbd at runtime
    "jieba",
    # spacy + its deps — another unused fallback in argos
    "spacy",
    "spacy_loggers",
    "spacy_legacy",
    "thinc",
    "blis",
    "preshed",
    "cymem",
    "murmurhash",
    "catalogue",
    "wasabi",
    "srsly",
    "langcodes",
    "typer",
    "cloudpathlib",
    "weasel",
    "smart_open",
    "confection",
    "shellingham",
]

STANZA_STUB = """
class Pipeline:
    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, text):
        return Document()

class Document:
    @property
    def sentences(self):
        return []

class Word:
    pass

class Sentence:
    pass

def download(*args, **kwargs):
    return None
"""

TORCH_STUB = """
class Tensor:
    pass

class Module:
    pass

def tensor(*args, **kwargs):
    return Tensor()

def no_grad():
    class _NoGrad:
        def __enter__(self): return self
        def __exit__(self, *args): pass
    return _NoGrad()

def is_available():
    return False

def cuda():
    class _Cuda:
        @staticmethod
        def is_available():
            return False
    return _Cuda()

cuda = type('cuda', (), {'is_available': staticmethod(lambda: False)})()
"""

TRANSFORMERS_STUB = """
class PreTrainedModel:
    pass

class PreTrainedTokenizer:
    pass

def pipeline(*args, **kwargs):
    raise RuntimeError("transformers is not bundled")
"""

SEP = ";" if sys.platform == "win32" else ":"


def step(index: int, total: int, message: str) -> None:
    print(f"\n[{index}/{total}] {message}")


def run(cmd: list[str], cwd: Path | None = None) -> None:
    printable = " ".join(f'"{part}"' if " " in part else part for part in cmd)
    print(f"  $ {printable}")
    subprocess.run(cmd, cwd=cwd, check=True)


def _expand_import_name(name: str) -> set[str]:
    if not name or name == "__future__":
        return set()

    parts = [part for part in name.split(".") if part]
    return {".".join(parts[:index]) for index in range(1, len(parts) + 1)}


def collect_cython_hidden_imports() -> list[str]:
    imports = set(BASE_HIDDEN_IMPORTS)
    imports.update(CYTHON_MODULES.keys())

    for rel_path in CYTHON_MODULES.values():
        source_path = SRC / rel_path
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.update(_expand_import_name(alias.name))
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    continue
                imports.update(_expand_import_name(node.module or ""))

    return sorted(imports)


def ensure_windows() -> None:
    if sys.platform != "win32":
        raise SystemExit(
            "This script must run with Windows Python to produce .pyd files and .exe. "
            "From WSL use: ./build.sh windows-cython"
        )
    if shutil.which("cl") is None:
        raise SystemExit(
            "MSVC compiler was not found. Run build_cython.bat or open a Developer "
            "Command Prompt for Visual Studio."
        )


def copy_sources() -> None:
    if BUILD_ROOT.exists():
        shutil.rmtree(BUILD_ROOT)
    shutil.copytree(
        SRC,
        WORK_SRC,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "*.pyd", "*.so", "*.c"),
    )
    OUTPUT.mkdir(exist_ok=True)


def create_stubs() -> None:
    (WORK_SRC / "stanza").mkdir(exist_ok=True)
    (WORK_SRC / "stanza" / "__init__.py").write_text(STANZA_STUB.lstrip("\n"), encoding="utf-8")

    (WORK_SRC / "torch").mkdir(exist_ok=True)
    (WORK_SRC / "torch" / "__init__.py").write_text(TORCH_STUB.lstrip("\n"), encoding="utf-8")

    (WORK_SRC / "transformers").mkdir(exist_ok=True)
    (WORK_SRC / "transformers" / "__init__.py").write_text(TRANSFORMERS_STUB.lstrip("\n"), encoding="utf-8")


def write_cython_setup() -> Path:
    extensions = ",\n        ".join(
        f'Extension("{module}", [r"src/{path.as_posix()}"])'
        for module, path in CYTHON_MODULES.items()
    )
    setup_script = BUILD_ROOT / "setup_cython.py"
    setup_script.write_text(
        "from setuptools import Extension, setup\n"
        "from Cython.Build import cythonize\n"
        "from Cython.Compiler import Options\n\n"
        "Options.docstrings = False\n\n"
        "extensions = [\n"
        f"        {extensions}\n"
        "]\n\n"
        "setup(\n"
        "    name='wordhunter_cython_build',\n"
        "    ext_modules=cythonize(\n"
        "        extensions,\n"
        "        compiler_directives={\n"
        "            'language_level': '3',\n"
        "            'binding': False,\n"
        "            'embedsignature': False,\n"
        "        },\n"
        "    ),\n"
        ")\n",
        encoding="utf-8",
    )
    return setup_script


def cython_compile() -> None:
    setup_script = write_cython_setup()
    (BUILD_ROOT / "wordhunter").mkdir(exist_ok=True)
    run([sys.executable, str(setup_script), "build_ext", "--inplace"], cwd=BUILD_ROOT)

    # PyInstaller scans WORK_SRC, while setuptools writes --inplace modules
    # under BUILD_ROOT/wordhunter when cwd is BUILD_ROOT.
    for pyd_file in (BUILD_ROOT / "wordhunter").glob("*.pyd"):
        shutil.move(pyd_file, WORK_SRC / "wordhunter" / pyd_file.name)


def strip_python_sources() -> None:
    for rel_path in CYTHON_MODULES.values():
        (WORK_SRC / rel_path).unlink(missing_ok=True)

    for generated in WORK_SRC.rglob("*.c"):
        generated.unlink(missing_ok=True)


def write_launcher() -> Path:
    launcher = BUILD_ROOT / "launcher.py"
    launcher.write_text(
        "import sys\n"
        "from pathlib import Path\n\n"
        "sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))\n"
        "from wordhunter.__main__ import main\n\n"
        "raise SystemExit(main())\n",
        encoding="utf-8",
    )
    return launcher


def pyinstaller_bundle(launcher: Path) -> None:
    icon = SRC / "wordhunter" / "assets" / "icon.ico"
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--clean",
        "--log-level",
        "ERROR",
        "--onefile",
        "--noconsole",
        "--name",
        APP_NAME,
        "--icon",
        str(icon),
        "--paths",
        str(WORK_SRC),
        "--add-data",
        f"{WORK_SRC / 'web'}{SEP}web",
        "--add-data",
        f"{WORK_SRC / 'wordhunter' / 'assets'}{SEP}wordhunter/assets",
        "--distpath",
        str(OUTPUT),
        "--workpath",
        str(BUILD_ROOT / "pyinstaller"),
        "--specpath",
        str(BUILD_ROOT),
        "--noconfirm",
    ]
    for module in collect_cython_hidden_imports():
        cmd.extend(["--hidden-import", module])
    for package in COLLECT_ALL:
        cmd.extend(["--collect-all", package])
    for mod in EXCLUDED_MODULES:
        cmd.extend(["--exclude-module", mod])
    cmd.append(str(launcher))
    run(cmd)


def main() -> None:
    ensure_windows()

    total = 5
    step(1, total, "Copying sources to isolated build directory")
    copy_sources()
    create_stubs()

    step(2, total, "Compiling Python modules with Cython")
    cython_compile()

    step(3, total, "Removing Python sources from build copy")
    strip_python_sources()

    step(4, total, "Creating minimal launcher")
    launcher = write_launcher()

    step(5, total, "Bundling Windows executable with PyInstaller")
    pyinstaller_bundle(launcher)

    print(f"\nDone: {OUTPUT / (APP_NAME + '.exe')}")


if __name__ == "__main__":
    main()
