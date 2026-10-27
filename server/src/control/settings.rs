//! Implements settings management endpoints.
use crate::Result;
use axum::{
    extract::State,
    http::{header, HeaderMap},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::store::{
    CommitPromptLocale, CommitSettings, DesktopSettings, ExternalApiSettings, PortSettings,
    ProxySettings, ProxySettingsInput, StatisticsStorage, StatisticsStorageScope, TabSettings,
    TokenPricingSettings,
};

use super::ControlState;

pub async fn get(State(service): State<ControlState>) -> Result<Json<ObservabilitySettings>> {
    Ok(Json(service.observability().await?))
}

#[derive(Deserialize)]
pub struct CursorDefaultModelInput {
    model_id: String,
}

pub async fn get_cursor_model(
    State(service): State<ControlState>,
) -> Result<Json<crate::store::CursorModelSettings>> {
    Ok(Json(service.store.cursor_model_settings().await?))
}

pub async fn update_cursor_model(
    State(service): State<ControlState>,
    Json(input): Json<CursorDefaultModelInput>,
) -> Result<Json<crate::store::CursorModelSettings>> {
    Ok(Json(
        service.set_cursor_default_model(&input.model_id).await?,
    ))
}

pub async fn update(
    State(service): State<ControlState>,
    Json(settings): Json<ObservabilitySettings>,
) -> Result<Json<ObservabilitySettings>> {
    Ok(Json(service.set_observability(settings).await?))
}

pub async fn get_ports(State(service): State<ControlState>) -> Result<Json<PortSettings>> {
    Ok(Json(service.store.port_settings().await?))
}

pub async fn update_ports(
    State(service): State<ControlState>,
    Json(settings): Json<PortSettings>,
) -> Result<Json<PortSettings>> {
    Ok(Json(service.set_ports(settings).await?))
}

pub async fn get_external_api(
    State(service): State<ControlState>,
) -> Result<Json<ExternalApiSettings>> {
    Ok(Json(service.store.external_api_settings().await?))
}

pub async fn update_external_api(
    State(service): State<ControlState>,
    Json(settings): Json<ExternalApiSettings>,
) -> Result<Json<ExternalApiSettings>> {
    Ok(Json(
        service.store.set_external_api_settings(settings).await?,
    ))
}

pub async fn get_storage(State(service): State<ControlState>) -> Result<Json<StatisticsStorage>> {
    Ok(Json(service.store.statistics_storage().await?))
}

pub async fn clear_storage(
    State(service): State<ControlState>,
    input: Option<Json<ClearStorageInput>>,
) -> Result<Json<StatisticsStorage>> {
    let scope = input.map(|Json(input)| input.scope).unwrap_or_default();
    let storage = match scope {
        StatisticsStorageScope::Details => service.store.clear_statistics_storage().await?,
        StatisticsStorageScope::All => service.store.clear_all_statistics_storage().await?,
    };
    Ok(Json(storage))
}

#[derive(Deserialize)]
pub struct ClearStorageInput {
    #[serde(default)]
    pub scope: StatisticsStorageScope,
}

pub async fn get_proxy(State(service): State<ControlState>) -> Result<Json<ProxySettings>> {
    Ok(Json(service.store.proxy_settings().await?))
}

pub async fn update_proxy(
    State(service): State<ControlState>,
    Json(settings): Json<ProxySettingsInput>,
) -> Result<Json<ProxySettings>> {
    Ok(Json(service.set_proxy_settings(settings).await?))
}

pub async fn get_tab(State(service): State<ControlState>) -> Result<Json<TabSettings>> {
    Ok(Json(service.store.tab_settings().await?))
}

pub async fn update_tab(
    State(service): State<ControlState>,
    Json(settings): Json<TabSettings>,
) -> Result<Json<TabSettings>> {
    Ok(Json(service.harness.set_tab_settings(settings).await?))
}

pub async fn get_desktop(State(service): State<ControlState>) -> Result<Json<DesktopSettings>> {
    Ok(Json(service.store.desktop_settings().await?))
}

pub async fn update_desktop(
    State(service): State<ControlState>,
    Json(settings): Json<DesktopSettings>,
) -> Result<Json<DesktopSettings>> {
    service.store.set_desktop_settings(settings).await?;
    get_desktop(State(service)).await
}

/// Settings view for commit message generation. Empty `model_id` means 直连
/// (forward the original Cursor RPC). A non-empty value is a configured
/// built-in or plugin model identifier. Empty `prompt` means "use the built-in default".
#[derive(Serialize)]
pub struct CommitSettingsView {
    pub model_id: String,
    pub prompt: String,
    pub prompt_locale: CommitPromptLocale,
    pub default_prompt: &'static str,
}

impl CommitSettingsView {
    fn new(settings: CommitSettings, default_locale: CommitPromptLocale) -> Self {
        Self {
            model_id: settings.model_id,
            prompt: settings.prompt,
            prompt_locale: settings.prompt_locale,
            default_prompt: default_locale.default_prompt(),
        }
    }
}

pub async fn get_commit(
    State(service): State<ControlState>,
    headers: HeaderMap,
) -> Result<Json<CommitSettingsView>> {
    let settings = service.store.commit_settings().await?;
    Ok(Json(CommitSettingsView::new(
        settings,
        requested_commit_locale(&headers),
    )))
}

pub async fn update_commit(
    State(service): State<ControlState>,
    Json(settings): Json<CommitSettings>,
) -> Result<Json<CommitSettingsView>> {
    let saved = service.store.set_commit_settings(settings).await?;
    let default_locale = saved.prompt_locale;
    Ok(Json(CommitSettingsView::new(saved, default_locale)))
}

pub async fn get_pricing_settings(
    State(service): State<ControlState>,
) -> Result<Json<TokenPricingSettings>> {
    Ok(Json(service.store.pricing_settings().await?))
}

pub async fn update_pricing_settings(
    State(service): State<ControlState>,
    Json(settings): Json<TokenPricingSettings>,
) -> Result<Json<TokenPricingSettings>> {
    Ok(Json(service.store.set_pricing_settings(settings).await?))
}

fn requested_commit_locale(headers: &HeaderMap) -> CommitPromptLocale {
    headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok())
        .map(CommitPromptLocale::from_interface_language)
        .unwrap_or(CommitPromptLocale::EnUs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_default_prompt_locale_comes_from_interface_language() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_LANGUAGE, "zh-CN".parse().unwrap());
        assert_eq!(requested_commit_locale(&headers), CommitPromptLocale::ZhCn);

        headers.insert(header::ACCEPT_LANGUAGE, "en-US".parse().unwrap());
        assert_eq!(requested_commit_locale(&headers), CommitPromptLocale::EnUs);

        headers.insert(header::ACCEPT_LANGUAGE, "pt-BR".parse().unwrap());
        assert_eq!(requested_commit_locale(&headers), CommitPromptLocale::EnUs);
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct ObservabilitySettings {
    pub detailed: bool,
}

impl ControlState {
    pub async fn observability(&self) -> Result<ObservabilitySettings> {
        Ok(ObservabilitySettings {
            detailed: self.store.detailed_logging().await?,
        })
    }

    pub async fn set_observability(
        &self,
        settings: ObservabilitySettings,
    ) -> Result<ObservabilitySettings> {
        self.store.set_detailed_logging(settings.detailed).await?;
        Ok(settings)
    }

    pub async fn set_ports(&self, settings: PortSettings) -> Result<PortSettings> {
        self.store.set_port_settings(settings).await?;
        Ok(settings)
    }

    pub async fn set_proxy_settings(&self, settings: ProxySettingsInput) -> Result<ProxySettings> {
        if settings.mode.is_custom() {
            let local_proxy_port = match self.harness.proxy_port().await {
                Some(port) => port,
                None => self.store.port_settings().await?.proxy_port,
            };
            crate::network::reject_self_proxy(&settings.address, local_proxy_port)?;
        }
        let settings = self.store.set_proxy_settings(settings).await?;
        self.clients.invalidate().await;
        Ok(settings)
    }

    pub async fn set_cursor_default_model(
        &self,
        model_id: &str,
    ) -> Result<crate::store::CursorModelSettings> {
        let model_id = model_id.trim();
        crate::cursor::services::default_model::validate(
            &self.store,
            Some(&self.plugins),
            model_id,
        )
        .await?;
        self.store.set_cursor_default_model(model_id).await
    }
}
