"""HTTP server for the Word Hunter REST API."""
from __future__ import annotations
import asyncio
import concurrent.futures
import html as html_lib
import http.server
import json
import mimetypes
import os
import re
import queue
import secrets
import socketserver
import subprocess
import sys
import threading
import traceback
import urllib.parse
import urllib.request
from pathlib import Path

import edge_tts

from wordhunter import __version__
from wordhunter.store import get_store
from wordhunter.ebook import import_ebook_payload

# Thread-safe queue for cross-thread export requests
_export_queue: queue.Queue = queue.Queue()

if hasattr(sys, "_MEIPASS"):
    WEB_ROOT = Path(sys._MEIPASS) / "web"
else:
    WEB_ROOT = Path(__file__).resolve().parents[1] / "web"

HOST = "127.0.0.1"
_WH_TOKEN = secrets.token_hex(16)


def _safe_err(e: Exception) -> str:
    return str(e).encode("ascii", errors="replace").decode("ascii")


def _configure_argos_runtime() -> None:
    """Keep Argos on the lightweight sentence splitter bundled in the app."""
    try:
        import argostranslate.settings as argos_settings

        chunk_type = getattr(argos_settings, "ChunkType", None)
        minisbd = getattr(chunk_type, "MINISBD", None) if chunk_type else None
        if minisbd is not None:
            argos_settings.chunk_type = minisbd
    except Exception:
        pass


class _Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args, **_kwargs):
        return

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/__proxy?"):
            return self._serve_proxy()
        if self.path.startswith("/__data"):
            return self._serve_data_dir()
        if self.path.startswith("/__media?"):
            return self._serve_media()
        if self.path.startswith("/__tts?"):
            return self._serve_edge_tts()
        if self.path.startswith("/__book/text?"):
            return self._serve_book_text()
        if self.path == "/__store/load":
            return self._serve_json(get_store().snapshot())
        if self.path.startswith("/__open_dict?"):
            return self._handle_open_dict()
        if self.path.startswith("/__argos/status"):
            return self._handle_argos_status()
        if self.path.startswith("/__argos/packages"):
            return self._handle_argos_packages()
        if self.path.startswith("/__argos/ui"):
            return self._handle_argos_ui()
        if self.path.startswith("/__argos/translate?"):
            return self._handle_argos_translate()
        if self.path == "/__update/check":
            return self._serve_update_check()
        return super().do_GET()

    def _handle_argos_ui(self):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        text = params.get("text", [""])[0]
        from_code = params.get("from", [""])[0]
        to_code = params.get("to", ["pl"])[0]
        theme = params.get("theme", ["auto"])[0]
        locale = params.get("locale", ["pl"])[0]

        try:
            import argostranslate.package
            installed = argostranslate.package.get_installed_packages()
            models = [{"from": p.from_code, "to": p.to_code} for p in installed]
            from_langs = sorted(list(set(m["from"] for m in models)))
            to_langs = sorted(list(set(m["to"] for m in models)))
        except Exception:
            from_langs = ["en", "pl", "de", "es", "fr", "it", "uk", "ru", "ja"]
            to_langs = ["en", "pl", "de", "es", "fr", "it", "uk", "ru", "ja"]

        lang_names = {}
        labels = {
            "title": "Argos Offline AI",
            "sourceLabel": "Tekst źródłowy",
            "targetLabel": "Tłumaczenie",
            "placeholder": "Wpisz słowo lub całe zdanie...",
            "targetPlaceholder": "Tłumaczenie pojawi się tutaj...",
            "footer": "Zasilane lokalnie przez Argos Translate",
            "copyBtn": "Kopiuj tłumaczenie",
            "copied": "Skopiowano!"
        }
        try:
            allowed_locales = {"pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"}
            if locale not in allowed_locales:
                locale = "en"
            i18n_path = WEB_ROOT / "i18n" / f"{locale}.json"
            if not i18n_path.exists():
                i18n_path = WEB_ROOT / "i18n" / "en.json"
            with open(i18n_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                lang_names = data.get("languages", {})
                if "translator" in data:
                    labels.update(data["translator"])
        except Exception:
            pass

        def get_lang_name(code):
            return lang_names.get(code, code.upper())

        host, port = self.server.server_address
        base_url = f"http://{HOST}:{port}"

        from_options = "".join(f'<option value="{l}" {"selected" if l==from_code else ""}>{get_lang_name(l)}</option>' for l in from_langs)
        to_options = "".join(f'<option value="{l}" {"selected" if l==to_code else ""}>{get_lang_name(l)}</option>' for l in to_langs)

        template_path = WEB_ROOT / "templates" / "translator-popup.html"
        with open(template_path, "r", encoding="utf-8") as f:
            html_content = f.read()

        html_content = html_content.replace("{{theme}}", html_lib.escape(theme))
        html_content = html_content.replace("{{title}}", html_lib.escape(labels["title"]))
        html_content = html_content.replace("{{base_url}}", html_lib.escape(base_url))
        html_content = html_content.replace("{{from_code}}", html_lib.escape(from_code))
        html_content = html_content.replace("{{to_code}}", html_lib.escape(to_code))
        html_content = html_content.replace("{{from_options}}", from_options)
        html_content = html_content.replace("{{to_options}}", to_options)
        html_content = html_content.replace("{{source_label}}", html_lib.escape(labels["sourceLabel"]))
        html_content = html_content.replace("{{placeholder}}", html_lib.escape(labels["placeholder"], quote=True))
        html_content = html_content.replace("{{target_placeholder}}", html_lib.escape(labels["targetPlaceholder"], quote=True))
        html_content = html_content.replace("{{text}}", html_lib.escape(text))
        html_content = html_content.replace("{{target_label}}", html_lib.escape(labels["targetLabel"]))
        html_content = html_content.replace("{{footer}}", html_lib.escape(labels["footer"]))
        html_content = html_content.replace("{{copy_btn}}", html_lib.escape(labels["copyBtn"]))
        html_content = html_content.replace("{{copied}}", html_lib.escape(labels["copied"]))

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html_content.encode("utf-8"))

    def _handle_open_dict(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        url = params.get("url", [""])[0]
        mode = params.get("mode", ["internal"])[0]
        title = params.get("title", ["Słownik"])[0]

        if url and hasattr(self.server, "main_window"):
            if url.startswith("/"):
                host, port = self.server.server_address
                url = f"http://{HOST}:{port}{url}"

            self.server.main_window.dictionary_requested.emit(url, mode, title)
        return self._send_no_content()

    def do_POST(self):  # noqa: N802
        if self.path == "/__log_error":
            length = int(self.headers.get("Content-Length", "0"))
            print("\n!!! UI ERROR !!!")
            print(self.rfile.read(length).decode("utf-8"))
            print("!!! UI ERROR !!!\n")
            return self._send_no_content()

        if self.path == "/__perf":
            payload = self._read_json()
            name = payload.get("name", "?")
            duration = payload.get("duration", 0)
            print(f"[PERF] {name}: {duration:.0f}ms")
            return self._send_no_content()

        if self.headers.get("X-WH-Token") != _WH_TOKEN:
            self.send_error(403, "forbidden")
            return

        if self.path == "/__store/save":
            return self._handle_bulk_save()
        elif self.path == "/__store/upsert_text":
            return self._handle_upsert_text()
        elif self.path == "/__book/image":
            return self._handle_book_image()
        elif self.path.startswith("/__store/delete_text"):
            return self._handle_delete_text()
        elif self.path.startswith("/__debug"):
            return self._handle_debug()
        elif self.path == "/__store/wipe":
            get_store().wipe()
            return self._send_no_content()
        elif self.path == "/__export/save":
            return self._handle_export_save()
        elif self.path == "/__import/ebook":
            return self._handle_import_ebook()
        elif self.path == "/__argos/install":
            return self._handle_argos_install()
        else:
            self.send_error(404)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _serve_json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_no_content(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _serve_proxy(self):
        try:
            qs = urllib.parse.urlparse(self.path).query
            target = urllib.parse.parse_qs(qs).get("url", [""])[0]
            if not target.startswith(("http://", "https://")):
                self.send_error(400, "bad url")
                return
            parsed = urllib.parse.urlparse(target)
            allowed_domains = {"gutenberg.org", "www.gutenberg.org", "gutendex.com"}
            if parsed.hostname not in allowed_domains:
                self.send_error(403, "domain not allowed")
                return
            req = urllib.request.Request(target, headers={"User-Agent": "WordHunter/0.1 (Qt)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
                ctype = r.headers.get("Content-Type", "text/plain; charset=utf-8")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f"proxy error: {_safe_err(e)}")

    def _serve_data_dir(self):
        try:
            target = get_store().dir
            if os.name == "nt":
                os.startfile(str(target))  # noqa: S606
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(target)])  # noqa: S603,S607
            else:
                subprocess.Popen(["xdg-open", str(target)])  # noqa: S603,S607
            self._send_no_content()
        except Exception as e:  # noqa: BLE001
            self.send_error(500, f"open error: {_safe_err(e)}")

    def _handle_argos_status(self):
        try:
            _configure_argos_runtime()
            import argostranslate.package
            installed = argostranslate.package.get_installed_packages()
            models = [{"from": p.from_code, "to": p.to_code} for p in installed]
            self._serve_json({"available": True, "models": models})
        except ImportError:
            self._serve_json({"available": False, "models": []})

    def _handle_argos_packages(self):
        try:
            _configure_argos_runtime()
            import argostranslate.package
            argostranslate.package.update_package_index()
            available = argostranslate.package.get_available_packages()
            result = []
            for pkg in available:
                pkg_size = getattr(pkg, 'size', 0) or 0
                size_mb = round(pkg_size / (1024 * 1024), 1) if pkg_size > 0 else 150
                result.append({
                    "from": pkg.from_code,
                    "to": pkg.to_code,
                    "size_mb": size_mb
                })
            self._serve_json({"packages": result})
        except Exception as e:
            self.send_error(500, f"argos packages error: {_safe_err(e)}")

    def _clean_argos_translation(self, text: str) -> str:
        cleaned = html_lib.unescape(str(text or ""))
        cleaned = cleaned.replace("\\n", "\n").replace("\\t", " ")
        cleaned = cleaned.replace("▁", " ").replace("<unk>", "")
        cleaned = re.sub(r"\{[A-Z]:\s*[^{}]{0,120}\}", "", cleaned)
        cleaned = re.sub(r"\{\s*\d+\s*\}", "", cleaned)
        cleaned = re.sub(r"\{\s*[A-Za-z0-9_$:;.,#@/\- ]{1,80}\s*\}", "", cleaned)
        cleaned = re.sub(r"^\s*[/\\|]+\s*", "", cleaned)
        cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
        cleaned = re.sub(r"\s+'", "'", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned.strip()

    def _handle_argos_translate(self):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        text = params.get("text", [""])[0]
        from_code = params.get("from", [""])[0]
        to_code = params.get("to", ["pl"])[0]
        try:
            _configure_argos_runtime()
            import argostranslate.translate
            try:
                translated = argostranslate.translate.translate(text, from_code, to_code)
            except Exception:
                if from_code != "en" and to_code != "en":
                    step1 = argostranslate.translate.translate(text, from_code, "en")
                    translated = argostranslate.translate.translate(step1, "en", to_code)
                else:
                    raise
            self._serve_json({"translated": self._clean_argos_translation(translated)})
        except Exception as e:
            self.send_error(500, f"argos error: {_safe_err(e)}")

    def _handle_argos_install(self):
        try:
            payload = self._read_json()
            from_codes = payload.get("from", [])
            to_codes = payload.get("to", [])
            _configure_argos_runtime()
            import argostranslate.package

            print(f"Argos: Updating package index...")
            argostranslate.package.update_package_index()
            available = argostranslate.package.get_available_packages()

            installed_count = 0
            pairs = []
            for f in from_codes:
                for t in to_codes:
                    if f != t:
                        pairs.append((f, t))

            print(f"Argos: Attempting to install {len(pairs)} potential language pairs...")

            for f, t in pairs:
                pkg = next(filter(lambda x: x.from_code == f and x.to_code == t, available), None)
                if pkg:
                    try:
                        print(f"Argos: Downloading {f}->{t}...")
                        download_path = pkg.download()
                        print(f"Argos: Installing {f}->{t} from {download_path}...")
                        argostranslate.package.install_from_path(download_path)
                        installed_count += 1
                    except Exception as pkg_err:
                        print(f"Argos: Failed to install {f}->{t}: {pkg_err}")
                else:
                    pass

            self._serve_json({"success": True, "installed": installed_count})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_error(500, f"argos install error: {_safe_err(e)}")

    def _serve_update_check(self):
        try:
            req = urllib.request.Request(
                "https://api.github.com/repos/Ironship/WordHunter/releases/latest",
                headers={"User-Agent": "WordHunter/0.1", "Accept": "application/vnd.github.v3+json"}
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode("utf-8"))
            latest = (data.get("tag_name") or "").lstrip("v")
            self._serve_json({"latest": latest, "current": __version__})
        except Exception as e:
            self._serve_json({"error": str(e)})

    def _handle_upsert_text(self):
        try:
            text = self._read_json()
            get_store().upsert_text(text)
            self._send_no_content()
        except Exception as e:  # noqa: BLE001
            self.send_error(400, f"text error: {_safe_err(e)}")

    def _handle_bulk_save(self):
        try:
            payload = self._read_json()
            store = get_store()

            # Validate all payloads before writing anything
            texts = payload.get("texts")
            if texts is not None and not isinstance(texts, list):
                raise ValueError("'texts' must be a list")
            prefs = payload.get("prefs")
            if prefs is not None and not isinstance(prefs, dict):
                raise ValueError("'prefs' must be an object")
            hidden = payload.get("hiddenBooks")
            if hidden is not None and not isinstance(hidden, list):
                raise ValueError("'hiddenBooks' must be a list")
            vocab = payload.get("vocab")
            if vocab is not None and not isinstance(vocab, dict):
                raise ValueError("'vocab' must be an object")

            # Save vocab first (most important — user's words)
            if vocab is not None:
                store.save_vocab(vocab or {})

            # Then save texts
            if texts is not None:
                store.sync_texts(texts or [])

            # Then save prefs and hidden books
            if prefs is not None:
                store.set_prefs(prefs or {})
            if hidden is not None:
                store.set_hidden_books(hidden or [])

            self._send_no_content()
        except Exception as e:  # noqa: BLE001
            self.send_error(400, f"save error: {_safe_err(e)}")

    def _serve_media(self):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        book_id = params.get("book", [""])[0]
        img_name = params.get("img", [""])[0]
        if book_id and img_name:
            book_id = os.path.basename(os.path.normpath(book_id))
            img_name = os.path.basename(img_name)
            p = get_store().books_dir / book_id / "images" / img_name
            if p.exists():
                with open(p, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(data)))
                ext = p.suffix.lower()
                ctype = "image/png"
                if ext in (".jpg", ".jpeg"): ctype = "image/jpeg"
                elif ext == ".gif": ctype = "image/gif"
                elif ext == ".webp": ctype = "image/webp"
                elif ext == ".svg": ctype = "image/svg+xml"
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "max-age=31536000")
                self.end_headers()
                self.wfile.write(data)
                return
        self.send_error(404, "not found")

    def _serve_edge_tts(self):
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            text = params.get("text", [""])[0]
            lang = params.get("lang", ["pl"])[0]

            voice_map = {
                "pl": "pl-PL-MarekNeural",
                "en": "en-US-AriaNeural",
                "de": "de-DE-ConradNeural",
                "es": "es-ES-AlvaroNeural",
                "fr": "fr-FR-HenriNeural",
                "it": "it-IT-DiegoNeural",
                "uk": "uk-UA-OstapNeural",
                "ru": "ru-RU-DmitryNeural",
                "ja": "ja-JP-KeitaNeural"
            }
            voice = voice_map.get(lang, "en-US-AriaNeural")

            async def get_audio():
                communicate = edge_tts.Communicate(text, voice)
                data = b""
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        data += chunk["data"]
                return data

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(asyncio.run, get_audio())
                audio_data = future.result(timeout=30)

            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(audio_data)))
            self.end_headers()
            self.wfile.write(audio_data)
        except Exception as e:
            self.send_error(502, f"Edge TTS failed: {_safe_err(e)}")

    def _serve_book_text(self):
        qs = urllib.parse.urlparse(self.path).query
        book_id = urllib.parse.parse_qs(qs).get("id", [""])[0]
        content = get_store().get_text_content(book_id)
        self._serve_json({"text": content})

    def _handle_book_image(self):
        try:
            payload = self._read_json()
            book_id = payload.get("book_id")
            img_name = payload.get("img_name")
            base64_data = payload.get("base64_data", "")

            if not book_id or not img_name or not base64_data:
                self.send_error(400, "missing data")
                return

            if "," in base64_data:
                base64_data = base64_data.split(",")[1]

            import base64
            data = base64.b64decode(base64_data)

            book_id = os.path.basename(os.path.normpath(book_id))
            img_name = os.path.basename(img_name)
            img_dir = get_store().books_dir / book_id / "images"
            img_dir.mkdir(parents=True, exist_ok=True)
            (img_dir / img_name).write_bytes(data)

            self._send_no_content()
        except Exception as e:
            self.send_error(400, f"image error: {_safe_err(e)}")

    def _handle_delete_text(self):
        try:
            payload = self._read_json()
            text_id = payload.get("id")
            if not text_id:
                raise ValueError("id required")
            get_store().delete_text(text_id)
            self._send_no_content()
        except Exception as e:  # noqa: BLE001
            self.send_error(400, f"delete error: {_safe_err(e)}")

    def _handle_debug(self):
        try:
            payload = self._read_json()
            print("FRONTEND DEBUG:", payload)
            self._send_no_content()
        except Exception:
            self.send_error(400, "debug error")

    def _handle_export_save(self):
        try:
            payload = self._read_json()
            data = payload.get("data", "")
            suggested = payload.get("filename", "export.txt")
            mime = payload.get("mime", "text/plain")
            _export_queue.put((data, suggested, mime))
            self._send_no_content()
        except Exception as e:
            self.send_error(400, f"export error: {_safe_err(e)}")

    def _handle_import_ebook(self):
        try:
            payload = self._read_json()
            result = import_ebook_payload(payload.get("filename", ""), payload.get("data", ""))
            self._serve_json(result)
        except Exception as e:
            self.send_error(400, f"ebook import error: {_safe_err(e)}")


def _start_server(directory: Path, main_window) -> int:
    class _Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    def _factory(*args, **kwargs):
        return _Handler(*args, directory=str(directory), **kwargs)

    httpd = _Server((HOST, 0), _factory)
    port = httpd.server_address[1]
    httpd.main_window = main_window
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return port
