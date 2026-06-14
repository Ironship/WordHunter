# TODO

## Discussion #14: vocabulary filtering by texts

- ~~Add exact source tracking for vocabulary entries.~~ Implemented as text-based index: vocabulary is filtered by checking whether a word appears in the selected text's tokenized content. A future version can add an optional `sources`/`textIds` field on entries for more precise tracking.
- ~~Add PDF export for per-text vocabulary lists.~~ TXT and Anki TSV export implemented through the existing native save path. PDF needs a separate renderer/export path and visual verification — deferred.
- Consider richer archive management, such as bulk archive/unarchive and a dedicated archive screen, if the current library archive filter is not enough.
