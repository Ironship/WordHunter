use rusqlite::params;
use serde_json::{Map, Value};

use super::Store;

impl Store {
    pub fn all_prefs(&self) -> Result<Value, String> {
        let inner = self.inner.lock().unwrap();
        let conn = Self::conn(&inner)?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM prefs")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut prefs = Map::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let key: String = row.get(0).map_err(|e| e.to_string())?;
            let raw: String = row.get(1).map_err(|e| e.to_string())?;
            let value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            prefs.insert(key, value);
        }
        Ok(Value::Object(prefs))
    }

    pub(crate) fn set_prefs(&self, prefs: &Map<String, Value>) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let mut conn = Self::conn(&inner)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM prefs", [])
            .map_err(|e| e.to_string())?;
        for (key, value) in prefs {
            tx.execute(
                "INSERT INTO prefs(key, value) VALUES (?1, ?2)",
                params![
                    key,
                    serde_json::to_string(value).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn hidden_books(&self) -> Result<Vec<String>, String> {
        let inner = self.inner.lock().unwrap();
        let conn = Self::conn(&inner)?;
        let mut stmt = conn
            .prepare("SELECT id FROM hidden_books")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for id in rows {
            ids.push(id.map_err(|e| e.to_string())?);
        }
        Ok(ids)
    }

    pub(crate) fn set_hidden_books(&self, hidden: &[Value]) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let mut conn = Self::conn(&inner)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM hidden_books", [])
            .map_err(|e| e.to_string())?;
        for id in hidden.iter().filter_map(Value::as_str) {
            tx.execute("INSERT INTO hidden_books(id) VALUES (?1)", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
