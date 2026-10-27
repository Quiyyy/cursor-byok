//! Persists the opt-in update owner and the exact settings it replaced.
use super::{now_ms, Store};
use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CursorUpdateSettings {
    pub enabled: bool,
    pub cohort: String,
    pub original: BTreeMap<String, Value>,
    pub applied: BTreeMap<String, Value>,
}
impl Default for CursorUpdateSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            cohort: uuid::Uuid::new_v4().to_string(),
            original: BTreeMap::new(),
            applied: BTreeMap::new(),
        }
    }
}
impl Store {
    pub async fn cursor_update_settings(&self) -> Result<CursorUpdateSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind("cursor_update_management")
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|json| serde_json::from_str(&json).map_err(Into::into))
            .unwrap_or_else(|| Ok(CursorUpdateSettings::default()))
    }
    pub async fn set_cursor_update_settings(&self, settings: &CursorUpdateSettings) -> Result<()> {
        let json = serde_json::to_string(settings)?;
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
            .bind("cursor_update_management").bind(json).bind(now_ms()).execute(&self.pool).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn update_owner_and_absent_or_null_settings_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();
        let mut saved = store.cursor_update_settings().await.unwrap();
        assert!(!saved.enabled);
        saved.enabled = true;
        saved.original.insert("update.mode".into(), Value::Null);
        saved
            .applied
            .insert("update.mode".into(), Value::String("none".into()));
        store.set_cursor_update_settings(&saved).await.unwrap();
        drop(store);
        let restored = Store::connect(&url)
            .await
            .unwrap()
            .cursor_update_settings()
            .await
            .unwrap();
        assert!(restored.enabled);
        assert_eq!(restored.cohort, saved.cohort);
        assert_eq!(restored.original.get("update.mode"), Some(&Value::Null));
        assert!(!restored
            .original
            .contains_key("cursor.agentHost.updateMode"));
    }
}
