//! Model settings: API models use their existing column; account overrides survive discovery.
use serde::{Deserialize, Serialize};

use super::{now_ms, Store};
use crate::{model::validate_context_window, Error, Result};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelSettings {
    pub context_window_tokens: Option<u64>,
}

impl Store {
    pub async fn model_settings(&self, id: &str) -> Result<ModelSettings> {
        if id.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
            let value: Option<String> =
                sqlx::query_scalar("SELECT value_json FROM service_settings WHERE setting_key = ?")
                    .bind(format!("model_settings:{id}"))
                    .fetch_optional(&self.pool)
                    .await?;
            return value
                .map(|value| serde_json::from_str(&value).map_err(Into::into))
                .unwrap_or_else(|| Ok(ModelSettings::default()));
        }
        let model = self
            .model(id)
            .await?
            .ok_or_else(|| Error::RunNotFound(format!("model {id}")))?;
        Ok(ModelSettings {
            context_window_tokens: model.context_window_tokens,
        })
    }

    pub async fn set_model_settings(
        &self,
        id: &str,
        settings: ModelSettings,
    ) -> Result<ModelSettings> {
        validate_context_window(settings.context_window_tokens)?;
        let _write = self.writes.lock().await;
        if id.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
            let key = format!("model_settings:{id}");
            if settings.context_window_tokens.is_none() {
                sqlx::query("DELETE FROM service_settings WHERE setting_key = ?")
                    .bind(key)
                    .execute(&self.pool)
                    .await?;
            } else {
                sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
                    .bind(key).bind(serde_json::to_string(&settings)?).bind(now_ms()).execute(&self.pool).await?;
            }
        } else {
            let result = sqlx::query("UPDATE model_configs SET context_window_tokens = ?, updated_at_ms = ? WHERE model_hash = ?")
                .bind(settings.context_window_tokens.map(|n| n as i64)).bind(now_ms()).bind(id).execute(&self.pool).await?;
            if result.rows_affected() != 1 {
                return Err(Error::RunNotFound(format!("model {id}")));
            }
        }
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn account_context_survives_reopen_is_scoped_by_model_and_can_reset() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let first = Store::connect(&url).await.unwrap();
        let id = "plugin:test/provider/grok-4.7";
        let settings = ModelSettings {
            context_window_tokens: Some(1_000_000),
        };
        first
            .set_model_settings(id, settings.clone())
            .await
            .unwrap();
        let reopened = Store::connect(&url).await.unwrap();
        assert_eq!(reopened.model_settings(id).await.unwrap(), settings);
        assert_eq!(
            reopened
                .model_settings("plugin:test/other/grok-4.7")
                .await
                .unwrap(),
            ModelSettings::default()
        );
        reopened
            .set_model_settings(id, ModelSettings::default())
            .await
            .unwrap();
        assert_eq!(
            first.model_settings(id).await.unwrap(),
            ModelSettings::default()
        );
    }
}
