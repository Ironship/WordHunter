"""Embed JS Word Hunter in QWebEngineView."""
from __future__ import annotations
import queue
import sys
import threading
import webbrowser
from pathlib import Path

from PySide6.QtCore import QUrl, Signal, Qt, QTimer
from PySide6.QtGui import QIcon, QCloseEvent, QDesktopServices
from PySide6.QtWidgets import QMainWindow, QDialog, QVBoxLayout, QFileDialog
from PySide6.QtWebEngineCore import QWebEngineScript, QWebEnginePage, QWebEngineDownloadRequest, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView

from wordhunter import __version__
from wordhunter.server import _start_server, WEB_ROOT, _WH_TOKEN, _export_queue, HOST
from wordhunter.store import data_dir

_BOOTSTRAP_TEMPLATE = """
(function() {
  window.__qtBridge = true;
  window.WH_TOKEN = "TOKEN_PLACEHOLDER";
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/__store/load', false);
    xhr.send(null);
    if (xhr.status === 200) {
      window.__bridgeState = JSON.parse(xhr.responseText);
    }
  } catch (e) { console.warn('bridge preload failed', e); }
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (/^https?:\\/\\/(www\\.)?gutenberg\\.org\\//i.test(url)) {
        const proxied = '/__proxy?url=' + encodeURIComponent(url);
        if (typeof input === 'string') return origFetch(proxied, init);
        return origFetch(new Request(proxied, input), init);
      }
    } catch (e) {}
    return origFetch(input, init);
  };
})();
"""
_BOOTSTRAP = _BOOTSTRAP_TEMPLATE.replace("TOKEN_PLACEHOLDER", _WH_TOKEN)


class ExternalLinkPage(QWebEnginePage):
    def acceptNavigationRequest(self, url, _type, isMainFrame):
        if url.scheme() in ('http', 'https'):
            QDesktopServices.openUrl(url)
        return False


class CustomWebEnginePage(QWebEnginePage):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._external_page = None

    def acceptNavigationRequest(self, url, _type, isMainFrame):
        if _type == QWebEnginePage.NavigationTypeLinkClicked:
            if url.scheme() in ('http', 'https') and url.host() not in (HOST, 'localhost'):
                QDesktopServices.openUrl(url)
                return False
        return super().acceptNavigationRequest(url, _type, isMainFrame)

    def createWindow(self, _type):
        self._external_page = ExternalLinkPage(self.profile(), self)
        return self._external_page

    def javaScriptConsoleMessage(self, level, message, line_number, source_id):
        if "Info" in str(level):
            return
        try:
            log_path = data_dir() / "app.log"
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"JS[{level}] {source_id}:{line_number}: {message}\n")
        except Exception:
            pass
        super().javaScriptConsoleMessage(level, message, line_number, source_id)


class MainWindow(QMainWindow):
    dictionary_requested = Signal(str, str, str)

    def __init__(self):
        super().__init__()
        self.dictionary_requested.connect(self.handle_dictionary_requested)
        self.dict_window = None

        self._export_timer = QTimer(self)
        self._export_timer.setInterval(1000)
        self._export_timer.timeout.connect(self._poll_export_queue)
        self._export_timer.start()

        self.setWindowTitle(f"Word Hunter {__version__}")
        if hasattr(sys, "_MEIPASS"):
            icon_path = Path(sys._MEIPASS) / "wordhunter" / "assets" / "icon.ico"
        else:
            icon_path = Path(__file__).resolve().parent / "assets" / "icon.ico"
        if icon_path.exists():
            self.setWindowIcon(QIcon(str(icon_path)))
        self.resize(1360, 880)
        port = _start_server(WEB_ROOT, self)
        self.view = QWebEngineView()
        self.page = CustomWebEnginePage(self.view)
        self.view.setPage(self.page)
        settings = self.view.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.Accelerated2dCanvasEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.WebGLEnabled, True)
        script = QWebEngineScript()
        script.setName("wh-bootstrap")
        script.setSourceCode(_BOOTSTRAP)
        script.setInjectionPoint(QWebEngineScript.DocumentCreation)
        script.setRunsOnSubFrames(False)
        script.setWorldId(QWebEngineScript.MainWorld)
        self.view.page().scripts().insert(script)
        self.view.load(QUrl(f"http://{HOST}:{port}/index.html"))
        self.setCentralWidget(self.view)
        self.view.page().profile().downloadRequested.connect(self.handle_download)

    def handle_download(self, download: QWebEngineDownloadRequest):
        suggested_name = download.suggestedFileName()
        path, _ = QFileDialog.getSaveFileName(self, "Zapisz plik", suggested_name)
        if path:
            import os
            download.setDownloadDirectory(os.path.dirname(path))
            download.setDownloadFileName(os.path.basename(path))
            download.accept()

    def closeEvent(self, event: QCloseEvent):
        self.view.page().runJavaScript("if (window.flushPendingSave) window.flushPendingSave();")
        try:
            from wordhunter.store import close_store
            close_store()
        except Exception:
            pass
        super().closeEvent(event)

    def _poll_export_queue(self):
        try:
            data, suggested, mime = _export_queue.get_nowait()
        except queue.Empty:
            return
        if suggested.endswith(".json"):
            ext_filter = "JSON (*.json)"
        elif suggested.endswith(".tsv"):
            ext_filter = "TSV (*.tsv)"
        elif suggested.endswith(".txt"):
            ext_filter = "Text (*.txt)"
        else:
            ext_filter = "All files (*)"
        path, _ = QFileDialog.getSaveFileName(self, "Zapisz plik", suggested, ext_filter)
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(data)

    def handle_dictionary_requested(self, url: str, mode: str, title: str = "Słownik"):
        if mode == "external":
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        else:
            if not self.dict_window:
                self.dict_window = QDialog(self)
                self.dict_window.setWindowTitle(title)
                self.dict_window.resize(800, 600)
                layout = QVBoxLayout(self.dict_window)
                layout.setContentsMargins(0, 0, 0, 0)
                self.dict_view = QWebEngineView(self.dict_window)
                layout.addWidget(self.dict_view)

                from PySide6.QtGui import QShortcut, QKeySequence
                shortcut = QShortcut(QKeySequence("Esc"), self.dict_window)
                from PySide6.QtCore import Qt
                shortcut.setContext(Qt.WidgetWithChildrenShortcut)
                shortcut.activated.connect(self.dict_window.close)

            self.dict_view.load(QUrl(url))
            self.dict_window.show()
            self.dict_window.raise_()
            self.dict_window.activateWindow()
