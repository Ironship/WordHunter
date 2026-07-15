# CEFR Course Books A1-B2

## Goal

Add one normal built-in book for every named supported learning language except
the custom Other profile, at levels A1, A2, B1, and B2. Each course is a single continuous plain-text book with
lesson headings, dialogues, practical texts, vocabulary in context, and exam
practice. Every book has its own SVG cover and appears in the existing Library.

The courses support exam preparation but do not promise a passing result or
replace an exam provider's current handbook, audio tasks, or assessed speaking
practice. Latin and Ancient Greek courses are CEFR-inspired because no common
A1-B2 examination standard exists for those languages.

## Shared Format

- Catalog ID: `starter-<lang>-<level>-course`
- Text: `books/starter/<lang>-<level>-course.txt`
- Cover: `books/starter/<lang>-<level>-course-cover.svg`
- Catalog level: exact uppercase `A1`, `A2`, `B1`, or `B2`
- Author and source: `Word Hunter Originals`
- Text encoding: UTF-8
- Cover: original 600 x 900 SVG beginning directly with `<svg>`
- Content: original target-language material, not copied from exam papers
- Structure: one title, one attribution, then all lessons in the same file
- Minimum scope: 24 substantial lessons and 12,000 characters per book
- Final lesson: integrated reading, writing, speaking, and listening-style
  practice that can be completed without embedded audio

## Level Progression

- A1: survival language, identity, family, home, routine, food, shopping,
  services, directions, travel, health, invitations, short forms and messages.
- A2: extended daily life, past events, plans, comparisons, housing, work,
  learning, media, travel problems, public services, simple explanations.
- B1: independent travel and work, connected narration, experiences, opinions,
  advice, complaints, formal messages, culture, news, environment, presentations.
- B2: detailed argument, nuance, professional and academic communication,
  media analysis, society, science, ethics, negotiation, reports and essays.

## Content Checklist

| Language | A1 text | A1 cover | A2 text | A2 cover | B1 text | B1 cover | B2 text | B2 cover |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| English (`en`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| German (`de`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Spanish (`es`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| French (`fr`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Italian (`it`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Polish (`pl`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Ukrainian (`uk`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Russian (`ru`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Japanese (`ja`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Simplified Chinese (`zh`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Latin (`la`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Ancient Greek (`grc`) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |

## Integration Checklist

- [x] Add 48 unique records to `src/web/books/index.json`.
- [x] Keep exactly one course book per language and level.
- [x] Update `src/web/books/starter/README.md` with course provenance.
- [x] Generalize the catalog test for stories plus course books.
- [x] Check every text and cover path referenced by the catalog.
- [x] Check titles, levels, IDs, minimum scope, and SVG metadata.
- [x] Review language and level progression samples.
- [x] Do not build application packages for this task.
- [x] Commit the completed course collection.
