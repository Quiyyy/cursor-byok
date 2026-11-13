//! Integrates local application settings.
use std::{collections::BTreeMap, fs, path::PathBuf};

use serde_json::Value;

use crate::{Error, Result};

const NO_PROXY_KEY: &str = "http.noProxy";
const KEYS: [&str; 5] = [
    "http.proxy",
    "http.proxyKerberosServicePrincipal",
    "http.proxySupport",
    "cursor.general.disableHttp2",
    "http.experimental.systemCertificatesV2",
];

fn path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    match std::env::consts::OS {
        "macos" => Ok(home.join("Library/Application Support/Cursor/User/settings.json")),
        "windows" => Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Cursor/User/settings.json")),
        "linux" => Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("Cursor/User/settings.json")),
        platform => Err(Error::Config(format!(
            "Cursor settings are unsupported on {platform}"
        ))),
    }
}

pub(super) fn read() -> Result<BTreeMap<String, Value>> {
    let path = path()?;
    let data = match fs::read_to_string(path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    if data.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    json5::from_str(&data)
        .map_err(|error| Error::Config(format!("parse Cursor settings JSONC: {error}")))
}

pub(super) fn write(settings: &BTreeMap<String, Value>) -> Result<()> {
    let path = path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_vec_pretty(settings)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, [data.as_slice(), b"\n"].concat())?;
    fs::rename(temp, path)?;
    Ok(())
}

pub(super) fn update_management_patch() -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("update.mode".into(), Value::String("none".into())),
        (
            "update.enableWindowsBackgroundUpdates".into(),
            Value::Bool(false),
        ),
        (
            "cursor.agentHost.updateMode".into(),
            Value::String("none".into()),
        ),
    ])
}

pub(super) fn restore_update_patch(
    current: &mut BTreeMap<String, Value>,
    saved: &crate::store::CursorUpdateSettings,
) {
    for (key, applied) in &saved.applied {
        if current.get(key) != Some(applied) {
            continue;
        }
        if let Some(original) = saved.original.get(key) {
            current.insert(key.clone(), original.clone());
        } else {
            current.remove(key);
        }
    }
}

pub fn write_proxy_settings(proxy_url: &str) -> Result<()> {
    let mut settings = read()?;
    settings.remove(NO_PROXY_KEY);
    settings.insert(KEYS[0].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[1].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[2].into(), Value::String("on".into()));
    settings.insert(KEYS[3].into(), Value::Bool(true));
    settings.insert(KEYS[4].into(), Value::Bool(true));
    write(&settings)
}

pub fn clear_proxy_settings() -> Result<()> {
    let mut settings = read()?;
    let before = settings.len();
    for key in KEYS {
        settings.remove(key);
    }
    if settings.len() != before {
        write(&settings)?;
    }
    Ok(())
}

pub fn settings_match(proxy_url: &str) -> Result<bool> {
    let settings = read()?;
    Ok(
        settings.get(KEYS[0]) == Some(&Value::String(proxy_url.into()))
            && settings.get(KEYS[1]) == Some(&Value::String(proxy_url.into()))
            && settings.get(KEYS[2]) == Some(&Value::String("on".into()))
            && settings.get(KEYS[3]) == Some(&Value::Bool(true))
            && settings.get(KEYS[4]) == Some(&Value::Bool(true)),
    )
}

pub fn clear_stale_managed_settings() -> Result<()> {
    let settings = read()?;
    let managed_signature = settings.get(KEYS[2]) == Some(&Value::String("on".into()))
        && settings.get(KEYS[3]) == Some(&Value::Bool(true))
        && settings.get(KEYS[4]) == Some(&Value::Bool(true));
    let loopback = settings
        .get(KEYS[0])
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<reqwest::Url>().ok())
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"));
    if managed_signature && loopback {
        clear_proxy_settings()?;
    }
    Ok(())
}

#[cfg(test)]
mod update_tests {
    use super::*;

    #[test]
    fn managed_updates_pin_both_editor_and_harness_and_restore_only_owned_values() {
        let original = BTreeMap::from([
            ("update.mode".into(), Value::String("manual".into())),
            ("cursor.agentHost.updateMode".into(), Value::Null),
            ("editor.fontSize".into(), Value::from(14)),
        ]);
        let applied = update_management_patch();
        assert_eq!(applied["update.mode"], "none");
        assert_eq!(applied["cursor.agentHost.updateMode"], "none");
        assert_eq!(applied["update.enableWindowsBackgroundUpdates"], false);
        let saved = crate::store::CursorUpdateSettings {
            enabled: true,
            original: original.clone(),
            applied: applied.clone(),
        };
        let mut current = original.clone();
        current.extend(applied.clone());
        restore_update_patch(&mut current, &saved);
        assert_eq!(current, original);
        current.extend(applied);
        current.insert("update.mode".into(), Value::String("start".into()));
        restore_update_patch(&mut current, &saved);
        assert_eq!(current["update.mode"], "start");
        assert_eq!(current["cursor.agentHost.updateMode"], Value::Null);
        assert!(!current.contains_key("update.enableWindowsBackgroundUpdates"));
    }
}
