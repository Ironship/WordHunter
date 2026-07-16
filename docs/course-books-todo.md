# A1-B2 Graded Readers

## Goal

Add one normal built-in book for every named supported learning language except
the custom Other profile, at levels A1, A2, B1, and B2. Each graded reader is a
single continuous plain-text book with chapter headings, connected stories,
practical texts, reading comprehension, and contextual vocabulary. Every reader
has its own SVG cover and appears in the existing Library.

These books are reading only. They make no full-course claim and provide no
systematic listening, speaking, or writing instruction. The importer is
recommended for readers' own lawful, nonconfidential materials. Modern-language
levels indicate approximate CEFR reading difficulty; Latin and Ancient Greek
levels indicate CEFR-inspired reading difficulty.

## Shared Format

- Catalog ID: `starter-<lang>-<level>-course`
- Text: `books/starter/<lang>-<level>-course.txt`
- Cover: `books/starter/<lang>-<level>-course-cover.svg`
- The `course` segment is retained only as a legacy technical ID and path convention.
- Catalog level: exact uppercase `A1`, `A2`, `B1`, or `B2`
- Author and source: `Word Hunter Originals`
- Text encoding: UTF-8
- Cover: original 600 x 900 SVG beginning directly with `<svg>`
- Content: original target-language reading material, not copied from third-party sources
- Structure: one first-line catalog title, one attribution, then all chapters in the same file
- Minimum scope: 24 substantial chapters and 12,000 characters per book
- Final chapter: integrated reading comprehension and contextual vocabulary review

## Level Progression

- A1: very short sentences and highly familiar themes such as identity, family,
  home, routine, food, shopping, services, directions, travel, and health.
- A2: connected everyday narratives about past events, plans, comparisons,
  housing, work, learning, media, travel problems, and public services.
- B1: sustained narratives about travel, work, experiences, viewpoints, culture,
  news, and the environment, with more varied contextual vocabulary.
- B2: nuanced extended texts about evidence, media, society, science, ethics,
  negotiation, and competing interpretations.

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
- [x] Keep exactly one graded reader per language and level.
- [x] Update `src/web/books/starter/README.md` with reader provenance.
- [x] Generalize the catalog test for stories plus graded readers.
- [x] Check every text and cover path referenced by the catalog.
- [x] Check titles, levels, IDs, minimum scope, and SVG metadata.
- [x] Review language and level progression samples.
- [x] Do not build application packages for this task.
- [x] Record the completed graded-reader collection.
