//! Official release discovery, bounded downloads and read-only Inno extraction.
use crate::{network, store::Store, Error, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const MAX_PACKAGE: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Product {
    pub version: String,
    pub commit: String,
    pub target: String,
    pub quality: String,
    #[serde(rename = "nameShort")]
    pub name: String,
}
impl Product {
    pub fn read(app: &Path) -> Result<Self> {
        let product: Self = serde_json::from_slice(&fs::read(app.join("product.json"))?)?;
        semver::Version::parse(&product.version).map_err(|e| Error::Config(e.to_string()))?;
        if product.name != "Cursor" || product.target != "user" || product.quality != "stable" {
            return Err(Error::Config(
                "Cursor updates require the Windows x64 stable user installation".into(),
            ));
        }
        let mut executable = fs::File::open(app.join("../../Cursor.exe"))?;
        let mut header = [0_u8; 64];
        executable.read_exact(&mut header)?;
        let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
        if &header[..2] != b"MZ" || offset > 16 * 1024 * 1024 {
            return Err(Error::Config("invalid Cursor executable".into()));
        }
        executable.seek(SeekFrom::Start(offset.into()))?;
        let mut machine = [0_u8; 6];
        executable.read_exact(&mut machine)?;
        if &machine[..4] != b"PE\0\0" || u16::from_le_bytes([machine[4], machine[5]]) != 0x8664 {
            return Err(Error::Config(
                "Cursor update management requires an x64 installation".into(),
            ));
        }
        Ok(product)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Release {
    #[serde(rename = "productVersion")]
    pub version: String,
    pub url: String,
}
impl Release {
    pub fn validate(&self) -> Result<()> {
        let version =
            semver::Version::parse(&self.version).map_err(|e| Error::Config(e.to_string()))?;
        if !version.pre.is_empty() || !official_package_url(&self.url) {
            return Err(Error::Config("invalid official Cursor user update".into()));
        }
        Ok(())
    }
    pub fn id(&self) -> String {
        hex::encode(Sha256::digest(self.url.as_bytes()))
    }
}

pub(super) fn official_package_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("downloads.cursor.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.fragment().is_none()
            && url.path().starts_with("/production/")
            && url.path().contains("/win32/x64/user-setup/")
            && url.path().ends_with(".exe")
    })
}

pub(super) async fn latest(
    store: &Store,
    current: &Product,
    cohort: &str,
) -> Result<Option<Release>> {
    let cohort = uuid::Uuid::parse_str(cohort).map_err(|e| Error::Config(e.to_string()))?;
    let url = format!(
        "https://api2.cursor.sh/updates/api/update/win32-x64-user/cursor/{}/{cohort}/stable",
        current.version
    );
    let response = network::client_builder(store)
        .await?
        .redirect(reqwest::redirect::Policy::none())
        .build()?
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    let bytes = response.error_for_status()?.bytes().await?;
    if bytes.len() > 64 * 1024 {
        return Err(Error::Config("Cursor update metadata is too large".into()));
    }
    let release: Release = serde_json::from_slice(&bytes)?;
    release.validate()?;
    if semver::Version::parse(&release.version).unwrap()
        <= semver::Version::parse(&current.version).unwrap()
    {
        return Ok(None);
    }
    Ok(Some(release))
}

pub(super) async fn download(
    store: &Store,
    release: &Release,
    path: &Path,
    cancel: &CancellationToken,
    progress: impl Fn(u64, Option<u64>),
) -> Result<String> {
    release.validate()?;
    let client = network::client_builder(store)
        .await?
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 3 && official_package_url(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()?;
    let response = tokio::select! {
        _=cancel.cancelled()=>return Err(Error::Cancelled),
        response=client.get(&release.url).timeout(Duration::from_secs(600)).send()=>response?,
    }
    .error_for_status()?;
    if !response.status().is_success() {
        return Err(Error::Config(
            "Cursor download redirected outside the official package host".into(),
        ));
    }
    let total = response.content_length();
    if total.is_some_and(|n| n > MAX_PACKAGE) {
        return Err(Error::Config(
            "Cursor installation package is too large".into(),
        ));
    }
    let staging = path.with_extension("part");
    let mut file = tokio::fs::File::create(&staging).await?;
    let mut bytes = 0_u64;
    let mut hash = Sha256::new();
    let mut stream = response.bytes_stream();
    let result: Result<()> = async {
        loop {
            let next=tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled), next=stream.next()=>next};
            let Some(chunk)=next else {break}; let chunk=chunk?;
            bytes=bytes.saturating_add(chunk.len() as u64);
            if bytes>MAX_PACKAGE {return Err(Error::Config("Cursor installation package is too large".into()));}
            file.write_all(&chunk).await?; hash.update(&chunk); progress(bytes,total);
        }
        file.sync_all().await?; Ok(())
    }.await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&staging).await;
        return Err(error);
    }
    tokio::fs::rename(&staging, path).await?;
    Ok(hex::encode(hash.finalize()))
}

pub(super) fn checksum(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn relative_destination(destination: &str) -> Result<Option<PathBuf>> {
    let relative = destination
        .strip_prefix("{code:GetDestDir}\\")
        .or_else(|| destination.strip_prefix("{app}\\"));
    let Some(relative) = relative else {
        return Ok(None);
    };
    let relative = relative.replace('\\', "/");
    if relative.is_empty()
        || relative.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.contains([':', '{', '}', '<', '>', '"', '|', '?', '*'])
                || part.ends_with(['.', ' '])
                || part.chars().any(|c| c.is_control())
                || reserved_windows_name(part)
        })
        || relative.starts_with('/')
    {
        return Err(Error::Config(
            "unsafe path in Cursor installation package".into(),
        ));
    }
    Ok(Some(PathBuf::from(relative)))
}

fn reserved_windows_name(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

pub(super) fn extract(
    installer: &Path,
    output: &Path,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    // Always use a fresh directory. The parser never executes Pascal or registry actions.
    fs::create_dir(output)?;
    let mut archive = inno::Inno::open(installer)
        .map_err(|e| Error::Config(format!("read Cursor installer: {e}")))?;
    let mut destinations = BTreeMap::new();
    let mut selected = BTreeSet::new();
    for (index, entry) in archive.file_entries().iter().enumerate() {
        if let Some(destination) = entry.destination() {
            if let Some(relative) = relative_destination(destination)? {
                let key = relative.to_string_lossy().to_lowercase();
                if let Some(previous) = destinations.insert(key, entry.location()) {
                    if previous != entry.location() {
                        return Err(Error::Config(
                            "conflicting duplicate path in Cursor installation package".into(),
                        ));
                    }
                } else {
                    selected.insert(index);
                }
            }
        }
    }
    let mut files = archive.streaming_files(|entry| selected.contains(&entry.index()));
    let mut total = 0_u64;
    while let Some(next) = files.next() {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let (entry, mut reader) =
            next.map_err(|e| Error::Config(format!("extract Cursor installer: {e}")))?;
        let relative = relative_destination(entry.file().destination().unwrap())?.unwrap();
        let path = output.join(relative);
        fs::create_dir_all(path.parent().unwrap())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        let mut buffer = [0_u8; 65536];
        loop {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            total = total.saturating_add(n as u64);
            if total > MAX_EXTRACTED {
                return Err(Error::Config(
                    "Cursor extracted package is too large".into(),
                ));
            }
            file.write_all(&buffer[..n])?;
        }
    }
    let app = output.join("resources/app");
    Product::read(&app)?;
    Ok(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packages_are_scoped_to_stable_official_user_installers() {
        assert!(official_package_url(
            "https://downloads.cursor.com/production/abc/win32/x64/user-setup/Cursor.exe"
        ));
        for url in [
            "http://downloads.cursor.com/production/a/win32/x64/user-setup/Cursor.exe",
            "https://downloads.cursor.com.evil.test/production/a/win32/x64/user-setup/Cursor.exe",
            "https://downloads.cursor.com/production/a/win32/x64/system-setup/Cursor.exe",
        ] {
            assert!(!official_package_url(url));
        }
        for path in [
            "{app}\\..\\outside.exe",
            "{app}\\C:\\outside.exe",
            "{app}\\\\server\\file",
            "{app}\\unknown:{name}",
            "{app}\\.. \\outside.exe",
            "{app}\\NUL.txt",
            "{app}\\COM1",
        ] {
            assert!(relative_destination(path).is_err());
        }
        assert_eq!(
            relative_destination("{code:GetDestDir}\\resources\\app\\product.json").unwrap(),
            Some(PathBuf::from("resources/app/product.json"))
        );
    }
    #[tokio::test]
    #[ignore = "requires CURSOR_UPDATE_TEST_INSTALLER; reads a real signed installer without executing it"]
    async fn real_installer_read_only_extraction() {
        let path = PathBuf::from(std::env::var_os("CURSOR_UPDATE_TEST_INSTALLER").unwrap());
        let dir = tempfile::tempdir().unwrap();
        let app = extract(
            &path,
            &dir.path().join("candidate"),
            &CancellationToken::new(),
        )
        .unwrap();
        let product = Product::read(&app).unwrap();
        assert_eq!(product.name, "Cursor");
        assert!(app
            .join("extensions/cursor-local-agent-runtime/dist/node_modules/piscina/package.json")
            .is_file());
        let native = crate::local_app::native_agent::NativeAgent::in_directory(
            app.clone(),
            dir.path().join("native"),
        );
        let before = checksum(&app.join("product.json")).unwrap();
        let checked = native.check_candidate(&app).await.unwrap();
        assert_eq!(checked.version, product.version);
        assert_eq!(before, checksum(&app.join("product.json")).unwrap());
        assert!(!dir.path().join("native/installations").exists());
    }
}
