//! Initializes and configures SQLite storage.
use std::{str::FromStr, time::Duration};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Connection, SqlitePool,
};

use crate::Result;

use super::{migrations, writer::WriteCoordinator};

#[derive(Clone)]
pub struct Store {
    pub(crate) pool: SqlitePool,
    pub(crate) writes: WriteCoordinator,
}

impl Store {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let options = SqliteConnectOptions::from_str(database_url)?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let database_path = options.get_filename().to_owned();
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            // Flush queued rollbacks before returning a connection to the pool.
            // If a transaction remains open, close it now so it cannot retain
            // SQLite's write lock or poison another conversation's next write.
            .after_release(|connection, _| {
                Box::pin(async move {
                    if connection.is_in_transaction() {
                        connection.ping().await?;
                    }
                    Ok(!connection.is_in_transaction())
                })
            })
            .connect_with(options)
            .await?;
        migrations::run(&pool, &database_path).await?;
        Ok(Self {
            pool,
            writes: WriteCoordinator::default(),
        })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temporary_store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();
        (directory, store)
    }

    async fn assert_writes_recover(store: &Store) {
        for _ in 0..4 {
            store.set_detailed_logging(true).await.unwrap();
        }
    }

    #[tokio::test]
    async fn failed_commit_does_not_poison_subsequent_writes() {
        let (_directory, store) = temporary_store().await;
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("PRAGMA defer_foreign_keys = ON")
            .execute(&mut *transaction)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO llm_call_response_chunks(call_id, seq, received_offset_ms, data, byte_count)
             VALUES ('missing-call', 0, 0, x'00', 1)",
        )
        .execute(&mut *transaction)
        .await
        .unwrap();
        assert!(transaction.commit().await.is_err());
        assert_writes_recover(&store).await;
    }

    #[tokio::test]
    async fn pooled_connection_with_unfinished_transaction_is_not_reused() {
        let (_directory, store) = temporary_store().await;
        let mut connection = store.pool.acquire().await.unwrap();
        let transaction = connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
        // Reproduce a pooled connection whose rollback did not complete.
        std::mem::forget(transaction);
        drop(connection);
        assert_writes_recover(&store).await;
    }
}
