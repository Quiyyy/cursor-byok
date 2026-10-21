//! Builds the top-level server router.

use crate::{cursor::services::CursorServices, network::NetworkClients, Result};

pub fn router(registry: CursorServices, clients: NetworkClients) -> Result<axum::Router> {
    super::cursor::router(registry, clients)
}
