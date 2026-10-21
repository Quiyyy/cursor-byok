//! Persists the configured Cursor default and its native refresh revision.
use serde::Serialize;

use super::{now_ms, Store};
use crate::Result;

const KEY: &str = "cursor_default_model";

#[derive(Clone, Debug, Default, Serialize)]
pub struct CursorModelSettings {
    pub model_id: String,
    pub updated_at_ms: i64,
}

impl Store {
    pub async fn cursor_model_settings(&self) -> Result<CursorModelSettings> {
        let row = sqlx::query_as::<_, (String, i64)>(
            "SELECT value_json, updated_at_ms FROM service_settings WHERE setting_key = ?",
        )
        .bind(KEY)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|(value, updated_at_ms)| {
            Ok(CursorModelSettings {
                model_id: serde_json::from_str(&value)?,
                updated_at_ms,
            })
        })
        .unwrap_or_else(|| Ok(CursorModelSettings::default()))
    }

    pub async fn set_cursor_default_model(&self, model_id: &str) -> Result<CursorModelSettings> {
        let _write = self.writes.lock().await;
        let updated_at_ms = sqlx::query_scalar(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = MAX(excluded.updated_at_ms, service_settings.updated_at_ms + 1) RETURNING updated_at_ms",
        ).bind(KEY).bind(serde_json::to_string(model_id)?).bind(now_ms())
            .fetch_one(&self.pool).await?;
        Ok(CursorModelSettings {
            model_id: model_id.into(),
            updated_at_ms,
        })
    }
}
