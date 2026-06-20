use serde_json::{json, Value};

use super::Store;

impl Store {
    pub fn load_vocab(&self) -> Result<Value, String> {
        let inner = self.inner.lock().unwrap();
        if inner.vocab_path.exists() {
            let raw = std::fs::read_to_string(&inner.vocab_path).map_err(|e| e.to_string())?;
            return serde_json::from_str(&raw).map_err(|e| e.to_string());
        }
        Ok(json!({}))
    }

    pub(crate) fn save_vocab(&self, vocab: &Value) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let tmp = inner.vocab_path.with_extension("tmp");
        let backup = inner.vocab_path.with_extension("bak");
        std::fs::write(
            &tmp,
            serde_json::to_string_pretty(vocab).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        if inner.vocab_path.exists() {
            // Remove a stale backup first. If removal fails (e.g. antivirus lock on
            // Windows), fall back to overwriting it via copy+remove so the subsequent
            // rename of the current file into `backup` can still succeed.
            if backup.exists() {
                if std::fs::remove_file(&backup).is_err() {
                    let _ = std::fs::copy(&inner.vocab_path, &backup);
                    // best-effort; if the current file can't be copied, continue and
                    // let the rename below surface a real error instead of failing silently
                }
            }
            // Move the current vocab aside so the final atomic rename targets a free path.
            // On Windows `rename` fails if the destination exists, which is why `backup`
            // must be cleared above.
            if let Err(e) = std::fs::rename(&inner.vocab_path, &backup) {
                // Rename failed: clean up the temp file so we don't leave stale artifacts,
                // then surface the real error instead of silently dropping data.
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("failed to back up existing vocab: {e}"));
            }
        }

        match std::fs::rename(&tmp, &inner.vocab_path) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Final rename failed. Try to restore the previous vocab from backup so
                // we don't end up with no vocab file at all.
                if backup.exists() {
                    let _ = std::fs::rename(&backup, &inner.vocab_path);
                }
                let _ = std::fs::remove_file(&tmp);
                Err(format!("failed to commit vocab save: {e}"))
            }
        }
    }
}
