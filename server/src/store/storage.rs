//! Row accounting and cleanup for disposable observability data.

use serde::{Deserialize, Serialize};

use crate::Result;

use super::Store;

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct StatisticsStorage {
    pub call_count: i64,
    pub trace_count: i64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StatisticsStorageScope {
    #[default]
    Details,
    All,
}

impl Store {
    pub async fn statistics_storage(&self) -> Result<StatisticsStorage> {
        let (call_count, trace_count) = sqlx::query_as::<_, (i64, i64)>(
            "SELECT (SELECT COUNT(*) FROM llm_calls), (SELECT COUNT(*) FROM cursor_run_traces)",
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(StatisticsStorage {
            call_count,
            trace_count,
        })
    }

    pub async fn clear_statistics_storage(&self) -> Result<StatisticsStorage> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        Self::clear_detail_storage_tx(&mut transaction).await?;
        transaction.commit().await?;
        self.reclaim_statistics_space().await?;
        self.statistics_storage().await
    }

    pub async fn clear_all_statistics_storage(&self) -> Result<StatisticsStorage> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        Self::clear_trace_artifacts_tx(&mut transaction).await?;
        sqlx::query("DELETE FROM llm_calls")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM cursor_run_traces")
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.reclaim_statistics_space().await?;
        self.statistics_storage().await
    }

    async fn reclaim_statistics_space(&self) -> Result<()> {
        // DELETE only places pages on SQLite's freelist. The user explicitly
        // requested cleanup; reclaim those pages without deleting conversations.
        sqlx::query("VACUUM").execute(&self.pool).await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn clear_detail_storage_tx(
        transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ) -> Result<()> {
        sqlx::query("DELETE FROM llm_call_requests")
            .execute(&mut **transaction)
            .await?;
        sqlx::query("DELETE FROM llm_call_response_chunks")
            .execute(&mut **transaction)
            .await?;
        Self::clear_trace_artifacts_tx(transaction).await
    }

    async fn clear_trace_artifacts_tx(
        transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ) -> Result<()> {
        sqlx::query(
            "CREATE TEMP TABLE IF NOT EXISTS clear_statistics_blob_ids(
                blob_id BLOB PRIMARY KEY
             )",
        )
        .execute(&mut **transaction)
        .await?;
        sqlx::query("DELETE FROM clear_statistics_blob_ids")
            .execute(&mut **transaction)
            .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO clear_statistics_blob_ids(blob_id)
             SELECT blob_id FROM cursor_run_trace_artifacts",
        )
        .execute(&mut **transaction)
        .await?;
        sqlx::query("DELETE FROM cursor_run_trace_artifacts")
            .execute(&mut **transaction)
            .await?;
        sqlx::query(
            "DELETE FROM blobs
             WHERE blob_id IN (SELECT blob_id FROM clear_statistics_blob_ids)
               AND NOT EXISTS (
                   SELECT 1 FROM cursor_run_trace_artifacts a WHERE a.blob_id = blobs.blob_id
               )
               AND NOT EXISTS (
                   SELECT 1 FROM blob_edges e
                   WHERE e.parent_blob_id = blobs.blob_id OR e.child_blob_id = blobs.blob_id
               )",
        )
        .execute(&mut **transaction)
        .await?;
        sqlx::query("DROP TABLE clear_statistics_blob_ids")
            .execute(&mut **transaction)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn manual_cleanup_reclaims_disk_space_and_preserves_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("storage.db");
        let store = Store::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        store.set_detailed_logging(true).await.unwrap();
        sqlx::query(
            "INSERT INTO llm_calls (
                call_id, run_id, conversation_id, provider_call_index, provider_type,
                provider_url, request_type, request_url, model_id, display_name,
                status, created_at_ms, message_count, tool_count, detailed
             ) VALUES ('call', 'run', 'keep-conversation', 0, 'openai',
                'http://test.invalid', 'chat', 'http://test.invalid', 'test', 'test',
                'completed', 0, 1, 0, 1)",
        )
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO llm_call_response_chunks(
                call_id, seq, received_offset_ms, data, byte_count
             ) VALUES ('call', 0, 0, zeroblob(4194304), 4194304)",
        )
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(store.pool())
            .await
            .unwrap();
        let before = std::fs::metadata(&path).unwrap().len();
        let stats = store.clear_statistics_storage().await.unwrap();
        assert_eq!(stats.call_count, 1);
        assert!(store.detailed_logging().await.unwrap());
        assert!(std::fs::metadata(&path).unwrap().len() < before / 2);
        let stats = store.clear_all_statistics_storage().await.unwrap();
        assert_eq!(stats.call_count, 0);
        assert!(store.detailed_logging().await.unwrap());
    }
}
