//! HTTP boundary for the single Cursor update coordinator.
use super::ControlService;
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
pub async fn status(State(service): State<ControlService>) -> Result<Json<Status>> {
    Ok(Json(service.cursor_harness().cursor_update_status().await?))
}
pub async fn configure(
    State(service): State<ControlService>,
    Json(input): Json<SettingsInput>,
) -> Result<Json<Status>> {
    Ok(Json(
        service
            .cursor_harness()
            .set_cursor_update_management(input.enabled)
            .await?,
    ))
}
pub async fn check(State(service): State<ControlService>) -> Result<Json<Status>> {
    Ok(Json(service.cursor_harness().check_cursor_update().await?))
}
pub async fn install(
    State(service): State<ControlService>,
    Json(input): Json<InstallInput>,
) -> Result<Json<Status>> {
    Ok(Json(
        service
            .cursor_harness()
            .install_cursor_update(&input.candidate_id)
            .await?,
    ))
}
pub async fn cancel(State(service): State<ControlService>) -> Result<Json<Status>> {
    Ok(Json(
        service
            .cursor_harness()
            .cancel_cursor_update_check()
            .await?,
    ))
}
pub async fn recover(State(service): State<ControlService>) -> Result<Json<Status>> {
    Ok(Json(
        service.cursor_harness().recover_cursor_update().await?,
    ))
}
