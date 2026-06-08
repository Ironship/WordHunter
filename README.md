# <img width="3410" height="1017" alt="Gemini_Generated_Image_1pfa6z1pfa6z1pfa" src="https://github.com/user-attachments/assets/5d236aa6-d669-49d0-8c41-5a2ee47d372b" />


# Easy spaced repetition learning tool with books and texts.

<img width="1920" height="1040" alt="image" src="https://github.com/user-attachments/assets/fb3d4c09-d930-4302-830f-671fab587660" />


[Word Hunter screenshot from 0.2.5 version work in progress]

# Latest release [download here](https://github.com/Ironship/WordHunter/releases)


Learn foreign languages by reading real texts — offline, no subscription, no ads.

Word Hunter is a desktop app that combines an ebook reader with a smart spaced-repetition system. You click a word → the app remembers it for you → later it quizzes you at optimal intervals. The more you read, the richer your vocabulary becomes.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/)
[![PySide6](https://img.shields.io/badge/Qt-PySide6-green.svg)](https://www.qt.io/)

---

## 💡 Why we built it this way (Design Philosophy)

Word Hunter was designed with specific principles in mind to provide the best, distraction-free language learning experience:

- **100% Offline & Private:** We built this as a standalone desktop app, not a web service. Why? Because your learning data, books, and vocabulary are yours. Everything is stored locally on your machine. No accounts, no telemetry, no subscriptions.
- **Reading-First Approach:** Vocabulary isn't learned in isolation. We tightly integrated the reader with the dictionary so you always learn words within their native context. The app automatically extracts the sentences where you found the word so you can review them later.
- **Smart Language Features:** Languages have quirks. For example, German has separable verbs (e.g., *stehe ... auf*). We built a "Smart Suggestion" engine that detects these edge cases and lets you intuitively merge words together. We also fully support multi-word phrases (like *das Fenster*) because languages are about chunks of meaning, not just isolated tokens.
- **Proven Algorithms:** Instead of reinventing the wheel, we implemented the tried-and-true SM-2 algorithm (the same one used by Anki). It guarantees that your flashcard reviews are spaced optimally, saving you time and maximizing retention.

---

## 📚 Library — Your Reading Collection

Already have books to study from? Add them and start learning vocabulary instantly.

- **Built-in texts** — a curated collection of books from Project Gutenberg, tagged with CEFR levels (A1–C1). Pick something appropriate for your level and read without second-guessing.
- **Custom texts** — drop in any text file, pick the language and difficulty. Every new reading becomes a fresh vocabulary source.
- **Edit books** — easily modify the title, author, cover, or even the full text of any added book directly from the library.
- **Filters & sorting** — search by title/author, filter by reading level, sort by progress or popularity.
- **Progress cards** — at a glance you see how many words you know, are learning, and still have ahead of you.

---

## 📖 Reader — read and learn at the same time

Open a book and start your journey. Words are color-coded based on your vocabulary:

- 🔴 **Red** = new, you haven't learned them yet
- 🟡 **Yellow** = learning, should review soon
- 🟢 **Green** = known, in your long-term memory
- ⚪ **Gray** = ignored

Click any word — a panel opens with info: translation, notes, example sentences from the text. The app automatically extracts the context where you encountered that word.

<img width="2560" height="1390" alt="GKkIAUvVTp" src="https://github.com/user-attachments/assets/91a13c3a-09f0-4539-8243-ceb53c98ce44" />
[old screenshot from 0.1.1 version]


<img width="2560" height="1390" alt="iMsiMMczRv" src="https://github.com/user-attachments/assets/4a0e7ac8-194e-4d93-ab02-72d4831e66bb" />
[old screenshot from 0.1 version]

---

## 🔊 Text-to-Speech — hear how every word sounds

No downloads needed — built-in speech synthesis reads any word or full paragraph aloud. You can slow it down to catch pronunciation better, and the voice matches your chosen learning language.

---

## 🧠 Vocabulary — manage your personal word bank

The app auto-adds words when you click them in the reader (you can also add manually). Each word entry has:

- **Status** — new, learning, known, ignored
- **Translation** — write your own or leave it blank for later
- **Notes** — save associations, mnemonics, anything that helps you remember
- **Examples** — auto-extracted sentences from the text (up to 3 per word)

Filter and search through thousands of words. Find something to delete or change? Edit it with a single click.

---

## 🃏 Flashcards — reviews that actually work

Powered by the **SuperMemo 2** (SM-2) algorithm — the same one Anki and Memrise use. The app decides when you're due for review:

- Remember a word well? → next review comes in a week, then a month
- Forget it? → we'll bring it back tomorrow
- The algorithm adapts frequency to your results automatically

Reverse mode — learn both directions: target language → native and native → target.

---

## 🔍 Discover — find the perfect book for you

Looking for reading material at your level? Search Project Gutenberg's catalog directly from within the app via the Gutendex API:

- **Filter by language** — English, German, French, and more
- **Level matching** — fairy tales → A2, fiction → B1, drama → B2, philosophy → C1
- **Vocabulary stats** — before adding a book, see how many unique words it contains and what percentage you already know
- **One-click add** — save your pick to the library instantly

---

## ⚙️ Settings — tailor the app to yourself

| What you can change | Why it matters |
|---------------------|----------------|
| **Theme** — light, dark, or auto | Read at night without straining your eyes |
| **Interface language** — 8 languages (PL, EN, DE, ES, FR, IT, UK, RU) | Use the app in your native tongue |
| **Learning language** — pick what you're studying | Adjusts translations and TTS voice automatically |
| **Font & size** — serif, sans-serif, monospace; size slider | Read comfortably for hours on end |
| **Line height** — compact, normal, loose | Matches your personal reading preference |
| **Text alignment** — left / center / right / justified | Choose the layout that feels natural to you |
| **Token highlighting** — toggle word colors on/off | Sometimes you just want clean text for printing |
| **Speech speed** — slow, normal, fast | Listen at the pace your brain processes |

---

## 🌐 9 Languages Supported

Word Hunter ships with full translations. Supported languages:

🇵🇱 Polski · 🇬🇧 English · 🇩🇪 Deutsch · 🇪🇸 Español · 🇫🇷 Français · 🇮🇹 Italiano · 🇺🇦 Українська · 🇷🇺 Państwo Moskiewskie · 🇯🇵 日本語

Interface language and learning language are independent — e.g., read in German while the app translates to Polish.

---

## 💻 How it works? (for the curious)

Word Hunter is a **single desktop application** — not a website, not a browser extension. You launch it and start reading immediately. Everything runs offline: book texts, vocabulary, reviews — all stored locally on your hard drive.

When you add new words or change settings, data is saved to `vocab.json` (plain JSON) and an SQLite database — so your data is always visible, backupable, and easy to export.

---

## 📦 Installation

### Requirements
- Windows 10/11

That's it. App is just a portable `.exe` file. No installation needed. User data is stored in `%APPDATA%\WordHunter`.

---

## ☕ Support the Project

If Word Hunter helps you learn languages and you'd like to support its continued development, consider buying me a coffee:

- [Suppi (PLN)](https://suppi.pl/aryo)
- [Patronite](https://patronite.pl/aryo)

Thank you! ❤️

---

## 📄 License

MIT License — see the `LICENSE` file.

---

## 🙏 Credits

- **Project Gutenberg** — free public domain books powering the built-in library
- **Piotr Woźniak / SuperMemo** — classic SM-2 algorithm behind spaced repetition (also used by Anki and Memrise)
- **Gutendex** — simple API wrapper around Project Gutenberg's catalog
- **YouGlish** — pronunciation video search engine embedded via iframe

## Why there is no source code?

In current state app code is bunch of scripts which are a litle bit messy. I want to cleanup it and think about architecture or how to handle extensions. On version 1.0 I want to publish it as complete learning tool.

---

## 📋 Changelog

### v0.2.7 (current)
- **Translator Tab** — dedicated offline neural translation tab (shortcut: `T`) with instant translate-as-you-type, source/target swap, auto-download language packs
- **Graphs Tab** — 9 canvas charts (due forecast, status donut, intervals, ease factor, repetitions, cards added, day-of-week, mature vs young, FSRS stability vs difficulty) + GitHub-style contribution heatmap
- **Keyboard Shortcut Overhaul** — `T` → Translator, `W` → jump to text, `G` → Graphs; removed conflicts
- **Library Sorting** — sort by known/new/learning word counts; reverse sort toggle
- **Image Selection** — Ctrl+1/2/3 badges; "own image" upload option
- **implement TTS Position-Aware Reading** — starts from clicked word, not beginning of page
- **attempts to implement session Persistence** — reader position saved on view switch; scroll restoration fallback
- **Settings Reorganization** — Reader, Flashcards, Translator & Dictionary sections
- **Flashcard UI Fixes** — card proportions, heatmap centering, overdue bar overlap fixed
- **Events.js Refactor** — split 1,335-line file into 5 feature submodules
- **Bug fixes** — translator state sync, XSS fix, duplicate IDs, graph clipping, mature/young legend layout

### v0.2.6
- **Offline AI Translation (Argos Translate)** — entirely offline neural engine; disabled by default, ~100-200 MB per language
- **Improved Focus Management** — no auto-focus conflicts with shortcuts
- **Escape Key Actions** — smooth unfocus for text boxes and image selection
- **Image Selection Shortcuts** — Ctrl+1/2/3 for top suggestions
- **Keyboard Shortcut Badges** — visual hints (E, N, I) in Reader word panel
- **Reader Progress Persistence** — remembers exact page per book
- **Configurable Anki Export** — defaults to "Learning" words with checkboxes
- **Vocab Search Debounce** — 200ms debounce
- **Critical Data Persistence Fix** — vocabulary and custom texts now save correctly
- **SQLite Thread Safety** — thread-local connections prevent corruption
- **EPUB Security Hardening** — ZIP bomb and XXE protection
- **Localization Overhaul** — full Japanese support; improved Ukrainian/Muscovian translations

### v0.2.5
- **New Formats** — EPUB, SRT, VTT, ASS native import
- **FSRS Algorithm** — optional Free Spaced Repetition Scheduler (default: SM-2)
- **YouGlish & Dictionary** — seamless integration in reader + flashcards
- **Custom Book Covers** — upload and assign cover images
- **Custom Tags** — add/remove tags for books
- **Review Input** — type translation directly during review if card back is empty
- **Settings Reorganization** — detailed data management (export, import, reset)

### v0.2.3
- **Microsoft Edge TTS** — higher quality voice synthesis (optional setting)

### v0.2.2
- **Bug fixes** — layout clipping, import element, image scaling, proxy URLs, book switching race condition
- **Clean-up** — removed hardcoded test books

### v0.2.1
- **9 Languages** — added Japanese; full interface and learning runtime localization
- **Multi-Word Phrases** — correct recognition of grouped terms (e.g., "das Fenster")
- **Wikipedia & Wikinews** — real-world article fetching with image rendering
- **Smart Suggestion Refinements** — blacklist to eliminate invalid separable verb combos
- **Book Editing** — modify title, author, cover, or full text
- **TinySegmenter** — Japanese text tokenization
- **Linux Build** — `Word.Hunter.Linux` portable binary

### v0.2.0 — Initial Public Release
- Built-in graded readers from Project Gutenberg (CEFR A1–C1)
- Interactive reader with color-coded word states
- SM-2 spaced repetition flashcards
- Vocabulary manager with status, translation, notes, examples
- Discover panel — search Gutenberg catalog via Gutendex API
- 8 interface languages
- YouGlish pronunciation video integration
- Light / Dark / Auto theme
- Custom text import
- Settings: font, size, line height, alignment, column width, TTS speed

---

*Word Hunter v0.2.7 — Learn languages by reading real texts.*
