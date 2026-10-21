//! Provides isolated stores and canonical message fixtures for tests.
#![allow(dead_code)]

use cursor_server::store::Store;

pub async fn temp_store() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("test.db").display());
    let store = Store::connect(&url).await.unwrap();
    (directory, store)
}
