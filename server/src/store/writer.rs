//! Serializes write transactions that mutate local configuration and request records.
use std::sync::Arc;

use tokio::sync::{Mutex, MutexGuard};

#[derive(Clone, Default)]
pub(crate) struct WriteCoordinator {
    lock: Arc<Mutex<()>>,
}

impl WriteCoordinator {
    pub(crate) async fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().await
    }
}
