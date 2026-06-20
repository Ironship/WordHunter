use serde_json::{json, Value};

use super::Store;

impl Store {
    pub fn snapshot(&self) -> Value {
        // Collect data, but also gather any component errors so the frontend can warn
        // the user instead of silently presenting an empty state (which masks data loss).
        let mut errors: Vec<String> = Vec::new();

        let texts = match self.all_texts() {
            Ok(v) => Value::Array(v),
            Err(e) => {
                errors.push(format!("texts: {e}"));
                Value::Array(Vec::new())
            }
        };
        let prefs = match self.all_prefs() {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("prefs: {e}"));
                json!({})
            }
        };
        let hidden_books = match self.hidden_books() {
            Ok(v) => Value::Array(v.into_iter().map(Value::from).collect()),
            Err(e) => {
                errors.push(format!("hiddenBooks: {e}"));
                Value::Array(Vec::new())
            }
        };
        let vocab = match self.load_vocab() {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("vocab: {e}"));
                json!({})
            }
        };

        // Surface component failures via stderr so they aren't silently swallowed.
        for err in &errors {
            eprintln!("[snapshot] failed to load {err}");
        }

        json!({
            "texts": texts,
            "prefs": prefs,
            "hiddenBooks": hidden_books,
            "vocab": vocab,
            "errors": errors,
        })
    }

    pub fn bulk_save(&self, payload: Value) -> Result<(), String> {
        if let Some(vocab) = payload.get("vocab") {
            self.save_vocab(vocab)?;
        }
        if let Some(texts) = payload.get("texts").and_then(Value::as_array) {
            self.sync_texts(texts)?;
        }
        if let Some(prefs) = payload.get("prefs").and_then(Value::as_object) {
            self.set_prefs(prefs)?;
        }
        if let Some(hidden) = payload.get("hiddenBooks").and_then(Value::as_array) {
            self.set_hidden_books(hidden)?;
        }
        Ok(())
    }

    pub fn wipe(&self) -> Result<(), String> {
        {
            let inner = self.inner.lock().unwrap();
            let conn = Self::conn(&inner)?;
            conn.execute("DELETE FROM prefs", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM hidden_books", [])
                .map_err(|e| e.to_string())?;
            if inner.vocab_path.exists() {
                std::fs::remove_file(&inner.vocab_path).map_err(|e| e.to_string())?;
            }
            let bak_path = inner.vocab_path.with_extension("bak");
            if bak_path.exists() {
                std::fs::remove_file(bak_path).map_err(|e| e.to_string())?;
            }
            if inner.books_dir.exists() {
                for entry in std::fs::read_dir(&inner.books_dir).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entry.path().is_dir() {
                        std::fs::remove_dir_all(entry.path())
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        Ok(())
    }
}
