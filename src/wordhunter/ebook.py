"""EPUB parsing and ebook import via Calibre."""
from __future__ import annotations
import base64
import html as html_lib
import io
import mimetypes
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


_WHITESPACE_RE = re.compile(r"\s+")
_MULTI_NL_RE = re.compile(r"\n{3,}")
_BLOCK_TAG_INSERT = re.compile(r'</?(p|div|section|article|chapter|br|li|tr|h[1-6])\b[^>]*>', re.IGNORECASE)
_SKIP_TAG_RE = re.compile(r'<(script|style|head|svg|math)\b[^>]*>.*?</\1>', re.DOTALL | re.IGNORECASE)
_TAG_RE = re.compile(r'<[^>]+>')
_TRAIL_SPACE_RE = re.compile(r"[ \t]+\n")


def _decode_epub_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1250", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _clean_imported_ebook_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _TRAIL_SPACE_RE.sub("\n", text)
    text = _MULTI_NL_RE.sub("\n\n", text)
    return text.strip()


def _strip_xhtml_to_text(markup: str) -> str:
    text = _SKIP_TAG_RE.sub("", markup)
    text = _BLOCK_TAG_INSERT.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = html_lib.unescape(text)
    text = _WHITESPACE_RE.sub(" ", text)
    text = _MULTI_NL_RE.sub("\n\n", text)
    return text.strip()


def _find_xml_text(root, local_name: str) -> str:
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] == local_name and element.text:
            return element.text.strip()
    return ""


def _epub_href(base_dir: str, href: str) -> str:
    return posixpath.normpath(posixpath.join(base_dir, urllib.parse.unquote(href)))


def _parse_epub(data: bytes, fallback_title: str) -> dict:
    MAX_ENTRIES = 500
    MAX_TOTAL_SIZE = 50_000_000
    MAX_FILE_SIZE = 10_000_000

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > MAX_ENTRIES:
            raise ValueError(f"EPUB contains too many entries (max {MAX_ENTRIES})")

        total_size = sum(info.file_size for info in archive.infolist())
        if total_size > MAX_TOTAL_SIZE:
            raise ValueError(f"EPUB uncompressed size too large (max {MAX_TOTAL_SIZE // 1_000_000} MB)")

        for info in archive.infolist():
            if info.file_size > MAX_FILE_SIZE:
                raise ValueError(f"File {info.filename} exceeds max size ({MAX_FILE_SIZE // 1_000_000} MB)")

        def _make_parser() -> ET.XMLParser:
            p = ET.XMLParser()
            try:
                p.entity.clear()
            except AttributeError:
                p.entity = {}
            return p

        container_data = archive.read("META-INF/container.xml")
        if len(container_data) > MAX_FILE_SIZE:
            raise ValueError("container.xml too large")
        container = ET.fromstring(container_data, parser=_make_parser())

        rootfile = ""
        for element in container.iter():
            if element.tag.rsplit("}", 1)[-1] == "rootfile":
                rootfile = element.attrib.get("full-path", "")
                break
        if not rootfile:
            raise ValueError("EPUB does not contain a rootfile entry")

        opf_data = archive.read(rootfile)
        if len(opf_data) > MAX_FILE_SIZE:
            raise ValueError("OPF file too large")
        opf_root = ET.fromstring(opf_data, parser=_make_parser())
        opf_dir = posixpath.dirname(rootfile)
        title = _find_xml_text(opf_root, "title") or fallback_title
        author = _find_xml_text(opf_root, "creator")

        manifest = {}
        spine = []
        for element in opf_root.iter():
            local = element.tag.rsplit("}", 1)[-1]
            if local == "item":
                item_id = element.attrib.get("id")
                href = element.attrib.get("href")
                if item_id and href:
                    manifest[item_id] = {
                        "href": href,
                        "media_type": element.attrib.get("media-type", ""),
                        "properties": element.attrib.get("properties", ""),
                    }
            elif local == "itemref":
                idref = element.attrib.get("idref")
                if idref:
                    spine.append(idref)

        text_parts = []
        for idref in spine:
            item = manifest.get(idref)
            if not item:
                continue
            href = item["href"]
            media_type = item["media_type"]
            if "html" not in media_type and not href.lower().endswith((".html", ".htm", ".xhtml")):
                continue
            path = _epub_href(opf_dir, href)
            try:
                markup = _decode_epub_text(archive.read(path))
            except KeyError:
                continue
            text = _strip_xhtml_to_text(markup)
            if text:
                text_parts.append(text)

        cover_data_url = ""
        cover_item = None
        for item in manifest.values():
            props = item.get("properties", "")
            item_id = item.get("href", "")
            media_type = item.get("media_type", "")
            if "cover-image" in props or ("image" in media_type and "cover" in item_id.lower()):
                cover_item = item
                break
        if cover_item:
            cover_path = _epub_href(opf_dir, cover_item["href"])
            try:
                cover_bytes = archive.read(cover_path)
                if len(cover_bytes) <= 1_500_000:
                    ctype = cover_item.get("media_type") or mimetypes.guess_type(cover_path)[0] or "image/jpeg"
                    cover_data_url = f"data:{ctype};base64,{base64.b64encode(cover_bytes).decode('ascii')}"
            except KeyError:
                pass

    text = _clean_imported_ebook_text("\n\n".join(text_parts))
    if not text:
        raise ValueError("No readable text found in EPUB")
    return {"title": title, "author": author, "text": text, "coverDataUrl": cover_data_url}


def _find_ebook_convert() -> str | None:
    found = shutil.which("ebook-convert")
    if found:
        return found
    candidates = [
        Path(os.environ.get("ProgramFiles", "")) / "Calibre2" / "ebook-convert.exe",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Calibre2" / "ebook-convert.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def _convert_with_calibre(data: bytes, suffix: str) -> str:
    converter = _find_ebook_convert()
    if not converter:
        raise ValueError("MOBI/AZW import requires Calibre and ebook-convert in PATH")
    with tempfile.TemporaryDirectory(prefix="wordhunter-ebook-") as tmp:
        src = Path(tmp) / f"input{suffix}"
        dst = Path(tmp) / "output.txt"
        src.write_bytes(data)
        result = subprocess.run(
            [converter, str(src), str(dst)],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode != 0:
            raise ValueError((result.stderr or result.stdout or "ebook-convert failed").strip())
        return _clean_imported_ebook_text(dst.read_text(encoding="utf-8", errors="replace"))


def import_ebook_payload(filename: str, encoded_data: str) -> dict:
    if "," in encoded_data:
        encoded_data = encoded_data.split(",", 1)[1]
    data = base64.b64decode(encoded_data)
    suffix = Path(filename or "").suffix.lower()
    title = Path(filename or "Imported ebook").stem
    if suffix == ".epub":
        return _parse_epub(data, title)
    if suffix in {".mobi", ".azw", ".azw3"}:
        text = _convert_with_calibre(data, suffix)
        if not text:
            raise ValueError("No readable text found after ebook-convert")
        return {"title": title, "author": "", "text": text, "coverDataUrl": ""}
    raise ValueError("Unsupported ebook format")
