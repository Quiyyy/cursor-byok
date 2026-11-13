//! HTTP boundary for the single Cursor update coordinator.
use super::ControlState;
use crate::{local_app::update::Status, Result};
use axum::{extract::State, Json};
use serde::Deserialize;
#[derive(Deserialize)]
pub struct SettingsInput {
    pub enabled: bool,
}
#[derive(Deserialize)]
pub struct InstallInput {
    pub candidate_id: String,
}
pub async fn status(State(service): State<ControlState>) -> Result<Json<Status>> {
    Ok(Json(service.harness.cursor_update_status().await?))
}
pub async fn configure(
    State(service): State<ControlState>,
    Json(input): Json<SettingsInput>,
) -> Result<Json<Status>> {
    Ok(Json(
        service
            .harness
            .set_cursor_update_management(input.enabled)
            .await?,
    ))
}
pub async fn check(State(service): State<ControlState>) -> Result<Json<Status>> {
    Ok(Json(service.harness.check_cursor_update().await?))
}
pub async fn install(
    State(service): State<ControlState>,
    Json(input): Json<InstallInput>,
) -> Result<Json<Status>> {
    Ok(Json(
        service
            .harness
            .install_cursor_update(&input.candidate_id)
            .await?,
    ))
}
pub async fn cancel(State(service): State<ControlState>) -> Result<Json<Status>> {
    Ok(Json(service.harness.cancel_cursor_update_check().await?))
}
pub async fn recover(State(service): State<ControlState>) -> Result<Json<Status>> {
    Ok(Json(service.harness.recover_cursor_update().await?))
}
