"""SQLite-backed storage for prefs + Filesystem for books + JSON file for vocab.

Why split:
- texts can grow large and contain images → Filesystem (folders per book).
- prefs are simple → SQLite.
- vocab is small and benefits from human-readable export → plain JSON.

Both files live under <data_dir>:
  Windows:  %APPDATA%/WordHunter
  *nix:     ~/.config/WordHunter
"""
from __future__ import annotations
import json
import logging
import logging.handlers
import os
import sqlite3
import threading
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_logger = logging.getLogger("wordhunter")
_logger.addHandler(logging.NullHandler())
_logger.setLevel(logging.WARNING)
_log_configured = False

# Guard against directory traversal in text_id / book_id
def _sanitize_id(id_str: str) -> str:
    """Strip path separators and reject traversal attempts."""
    cleaned = os.path.basename(os.path.normpath(id_str))
    if cleaned in (".", "..", ""):
        raise ValueError(f"Invalid id: {id_str!r}")
    return cleaned


def data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    p = Path(base) / "WordHunter"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _ensure_logging(data_dir_path: Path) -> None:
    global _log_configured
    if _log_configured:
        return
    log_path = data_dir_path / "app.log"
    handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=1_048_576, backupCount=3, encoding="utf-8"
    )
    handler.setLevel(logging.WARNING)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    ))
    _logger.addHandler(handler)
    _log_configured = True


class Store:
    def __init__(self) -> None:
        self.dir = data_dir()
        _ensure_logging(self.dir)
        self.db_path = self.dir / "store.sqlite"
        self.vocab_path = self.dir / "vocab.json"
        self.books_dir = self.dir / "books"
        self._lock = threading.RLock()
        # Use a connection per thread for thread safety with check_same_thread=False
        self._local = threading.local()
        self.books_dir.mkdir(exist_ok=True)
        self._init_schema()
        self._migrate_texts_to_fs()

    def _get_conn(self) -> sqlite3.Connection:
        """Get thread-local SQLite connection."""
        if not hasattr(self._local, 'conn') or self._local.conn is None:
            self._local.conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    # ---- schema ----
    def _init_schema(self) -> None:
        conn = self._get_conn()
        with self._lock, conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS prefs (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hidden_books (
                    id TEXT PRIMARY KEY
                )
                """
            )

    def _migrate_texts_to_fs(self) -> None:
        conn = self._get_conn()
        with self._lock, conn:
            cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='texts'")
            if not cur.fetchone():
                return
            
            cur = conn.execute("SELECT id, payload FROM texts")
            rows = cur.fetchall()
            
            migrated_ids = []
            failed_ids = []
            for row in rows:
                try:
                    book = json.loads(row["payload"])
                    # Don't call self.upsert_text() — it acquires self._lock again
                    # and we already hold it. Write directly.
                    text_id = book.get("id")
                    if not text_id:
                        failed_ids.append(row["id"])
                        continue
                    safe_id = _sanitize_id(text_id)
                    book_dir = self.books_dir / safe_id
                    book_dir.mkdir(parents=True, exist_ok=True)
                    raw_text = book.pop("text", None)
                    if raw_text is not None:
                        (book_dir / "text.txt").write_text(raw_text, encoding="utf-8")
                    (book_dir / "metadata.json").write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
                    migrated_ids.append(row["id"])
                except Exception:
                    _logger.warning("Failed to migrate text row %s", row["id"], exc_info=True)
                    failed_ids.append(row["id"])
            
            # Only drop table if ALL rows migrated successfully
            if not failed_ids:
                conn.execute("DROP TABLE texts")
            else:
                _logger.warning("Migration incomplete: %d/%d rows migrated. Keeping SQLite table.", len(migrated_ids), len(rows))

    # ---- texts ----
    def all_texts(self) -> List[Dict[str, Any]]:
        with self._lock:
            if not self.books_dir.exists():
                return []
            books = []
            for child in self.books_dir.iterdir():
                if child.is_dir():
                    meta_path = child / "metadata.json"
                    if meta_path.exists():
                        try:
                            books.append(json.loads(meta_path.read_text(encoding="utf-8")))
                        except Exception:
                            _logger.warning("Failed to read metadata from %s", child.name, exc_info=True)
            return books

    def upsert_text(self, text: Dict[str, Any]) -> None:
        text_id = text.get("id")
        if not text_id:
            raise ValueError("text.id required")
        safe_id = _sanitize_id(text_id)
        
        with self._lock:
            book_dir = self.books_dir / safe_id
            book_dir.mkdir(parents=True, exist_ok=True)
            
            # Copy the dict so we don't mutate the caller's copy
            meta = {k: v for k, v in text.items()}
            raw_text = meta.pop("text", None)
            if raw_text is not None:
                (book_dir / "text.txt").write_text(raw_text, encoding="utf-8")
            
            (book_dir / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    def sync_texts(self, texts: List[Dict[str, Any]]) -> None:
        with self._lock:
            # Write all new data BEFORE deleting old data to avoid data loss on crash
            for t in texts:
                if t.get("id"):
                    self.upsert_text(t)
            
            # Now remove books not in the new list
            requested_ids = {t.get("id") for t in texts if t.get("id")}
            if self.books_dir.exists():
                for child in list(self.books_dir.iterdir()):
                    if child.is_dir() and child.name not in requested_ids:
                        shutil.rmtree(child, ignore_errors=True)

    def get_text_content(self, text_id: str) -> str:
        safe_id = _sanitize_id(text_id)
        with self._lock:
            p = self.books_dir / safe_id / "text.txt"
            if p.exists():
                return p.read_text(encoding="utf-8")
            return ""

    def delete_text(self, text_id: str) -> None:
        safe_id = _sanitize_id(text_id)
        with self._lock:
            book_dir = self.books_dir / safe_id
            if book_dir.exists():
                shutil.rmtree(book_dir, ignore_errors=True)

    # ---- prefs ----
    def all_prefs(self) -> Dict[str, Any]:
        conn = self._get_conn()
        with self._lock:
            cur = conn.execute("SELECT key, value FROM prefs")
            return {r["key"]: json.loads(r["value"]) for r in cur.fetchall()}

    def set_prefs(self, prefs: Dict[str, Any]) -> None:
        conn = self._get_conn()
        with self._lock:
            # Use savepoint so we can rollback on failure
            conn.execute("SAVEPOINT set_prefs")
            try:
                conn.execute("DELETE FROM prefs")
                conn.executemany(
                    "INSERT INTO prefs(key, value) VALUES (?, ?)",
                    [(k, json.dumps(v, ensure_ascii=False)) for k, v in prefs.items()],
                )
                conn.execute("RELEASE SAVEPOINT set_prefs")
            except Exception:
                conn.execute("ROLLBACK TO SAVEPOINT set_prefs")
                raise

    def set_hidden_books(self, ids: List[str]) -> None:
        conn = self._get_conn()
        with self._lock:
            conn.execute("SAVEPOINT set_hidden_books")
            try:
                conn.execute("DELETE FROM hidden_books")
                conn.executemany(
                    "INSERT INTO hidden_books(id) VALUES (?)",
                    [(i,) for i in ids],
                )
                conn.execute("RELEASE SAVEPOINT set_hidden_books")
            except Exception:
                conn.execute("ROLLBACK TO SAVEPOINT set_hidden_books")
                raise

    def hidden_books(self) -> List[str]:
        conn = self._get_conn()
        with self._lock:
            cur = conn.execute("SELECT id FROM hidden_books")
            return [r["id"] for r in cur.fetchall()]

    # ---- vocab (JSON file) ----
    def load_vocab(self) -> Dict[str, Any]:
        if self.vocab_path.exists():
            try:
                return json.loads(self.vocab_path.read_text(encoding="utf-8"))
            except Exception:
                _logger.warning("Failed to load vocab.json, trying backup", exc_info=True)
        
        # Try backup if main file is missing or corrupt
        backup = self.vocab_path.with_suffix(".bak")
        if backup.exists():
            try:
                data = json.loads(backup.read_text(encoding="utf-8"))
                _logger.info("Recovered vocab from backup")
                # Restore backup as main file
                try:
                    backup.replace(self.vocab_path)
                except OSError:
                    pass
                return data
            except Exception:
                _logger.warning("Failed to load vocab backup", exc_info=True)
        
        return {}

    def save_vocab(self, vocab: Dict[str, Any]) -> None:
        """Save vocab with atomic write + backup of previous file."""
        with self._lock:
            tmp = self.vocab_path.with_suffix(".tmp")
            backup = self.vocab_path.with_suffix(".bak")
            data = json.dumps(vocab, ensure_ascii=False, indent=2)
            tmp.write_text(data, encoding="utf-8")
            # Backup existing vocab before overwriting
            if self.vocab_path.exists():
                try:
                    if backup.exists():
                        backup.unlink()
                    self.vocab_path.rename(backup)
                except OSError as e:
                    _logger.warning("Failed to create vocab backup: %s", e)
            # Atomic replace with retry
            for attempt in range(5):
                try:
                    tmp.replace(self.vocab_path)
                    break
                except PermissionError:
                    if attempt == 4:
                        _logger.error("Failed to save vocab after 5 attempts")
                        raise
                    time.sleep(0.1 * (attempt + 1))
            # Clean up temp file if it still exists
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass

    # ---- snapshot ----
    def snapshot(self) -> Dict[str, Any]:
        return {
            "texts": self.all_texts(),
            "prefs": self.all_prefs(),
            "hiddenBooks": self.hidden_books(),
            "vocab": self.load_vocab(),
        }

    def wipe(self) -> None:
        conn = self._get_conn()
        with self._lock, conn:
            conn.execute("DELETE FROM prefs")
            conn.execute("DELETE FROM hidden_books")
        if self.vocab_path.exists():
            self.vocab_path.unlink()
        # Clean up vocab backup too
        backup = self.vocab_path.with_suffix(".bak")
        if backup.exists():
            backup.unlink()
        if self.books_dir.exists():
            for child in self.books_dir.iterdir():
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)

    def close(self) -> None:
        """Close all thread-local connections."""
        if hasattr(self._local, 'conn') and self._local.conn is not None:
            self._local.conn.close()
            self._local.conn = None


_STORE: Optional[Store] = None
_store_lock = threading.Lock()


def get_store() -> Store:
    global _STORE
    if _STORE is None:
        with _store_lock:
            if _STORE is None:
                _STORE = Store()
    return _STORE


def close_store() -> None:
    """Close the global store connections."""
    global _STORE
    if _STORE is not None:
        _STORE.close()
        _STORE = None
