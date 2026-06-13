# TODO

## Discussion #14: vocabulary filtering by texts

- Add exact source tracking for vocabulary entries. Today the safe implementation filters words by whether they appear in the selected text. A future version can add an optional `sources`/`textIds` field on entries, filled when a word is added from the reader, while treating older entries as having unknown source.
- Add PDF export for per-text vocabulary lists. TXT export is implemented through the existing native save path; PDF needs a separate renderer/export path and visual verification.
- Consider richer archive management, such as bulk archive/unarchive and a dedicated archive screen, if the current library archive filter is not enough.
