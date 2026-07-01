export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function cleanCatalogTitle(value) {
  return String(value || "")
    .replace(/\s*:\s*\$[a-z]\s*/gi, ": ")
    .replace(/\s*\/\s*\$[a-z]\s*/gi, " / ")
    .replace(/\s+\$[a-z]\s*/gi, " ")
    .replace(/\s+([:;,])/g, "$1")
    .replace(/([:;,])(?=\S)/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseTagList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const seen = new Set();
  const tags = [];

  source.forEach((raw) => {
    const tag = String(raw || "").trim().replace(/\s+/g, " ");
    if (!tag) return;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  });

  return tags;
}

export function formatTagList(value) {
  return parseTagList(value).join(", ");
}

import { t } from "./i18n.js";

const STATUS_LABEL_MAP = { new: "vocab.statusNew", learning: "vocab.statusLearning", known: "vocab.statusKnown", ignored: "vocab.statusIgnored" };

export function statusLabel(status) {
  return t(STATUS_LABEL_MAP[status] || STATUS_LABEL_MAP.new);
}

export function calcStatsPcts(stats) {
  const total = stats.known + stats.ignored + stats.learning + stats.new;
  if (!total) return { knownPct: 0, learningPct: 0, newPct: 0, total: 0 };
  const knownPct = ((stats.known + stats.ignored) / total) * 100;
  const learningPct = (stats.learning / total) * 100;
  const newPct = 100 - knownPct - learningPct;
  return { knownPct, learningPct, newPct, total };
}
