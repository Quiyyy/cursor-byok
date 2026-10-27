//! Implements local application control endpoints.
use axum::{extract::State, Json};

use crate::{
    local_app::{CursorHarnessStatus, SetEnabled},
    Result,
};

use super::ControlState;

pub async fn status(State(service): State<ControlState>) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.harness.status().await?))
}

pub async fn initialize_ca(
    State(service): State<ControlState>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.harness.initialize_ca().await?))
}

pub async fn set_enabled(
    State(service): State<ControlState>,
    Json(input): Json<SetEnabled>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.harness.set_enabled(input.enabled).await?))
}
