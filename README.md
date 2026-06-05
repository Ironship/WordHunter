# <img width="3410" height="1017" alt="Gemini_Generated_Image_1pfa6z1pfa6z1pfa" src="https://github.com/user-attachments/assets/5d236aa6-d669-49d0-8c41-5a2ee47d372b" />


# Easy spaced repetition learning tool with books and texts.


<img width="2560" height="1390" alt="5uMgNPR0lD" src="https://github.com/user-attachments/assets/07f4a3d6-37e3-491b-81f5-d2d1218a55d0" />
[old screenshot from 0.1 version]

# Latest release [download here](https://github.com/Ironship/WordHunter/releases/tag/WordHunterv0.2.2)

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

## 🚀 Roadmap (TODO)

Here is a glimpse of features we are planning for the future to make Word Hunter even better:

- **[FEATURE] Better text to speech:** Integrating more advanced TTS engines (e.g., Edge TTS, Google Cloud, or OpenAI) for more natural-sounding voices and native-like intonation.
- **[FEATURE] Import tool for subtitles as word source:** Allowing users to import `.srt` or `.vtt` movie/series subtitles so they can learn vocabulary directly from their favorite shows and videos.

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

---

*Word Hunter v0.2.0 — Learn languages by reading real texts.*
