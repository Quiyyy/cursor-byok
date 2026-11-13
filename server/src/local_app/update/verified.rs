//! Maintainer-verified combinations. Extend only after real native-run acceptance.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct VerifiedRelease {
    pub version: &'static str,
    pub commit: &'static str,
    pub harness: &'static str,
}

pub const WINDOWS_X64: &[VerifiedRelease] = &[VerifiedRelease {
    version: "3.28.7",
    commit: "25b52e7d03ebf2d5608914158e119f7992432a30",
    harness: "builtin",
}];

pub fn latest() -> VerifiedRelease {
    WINDOWS_X64[0]
}

pub fn supports_version(version: &str) -> bool {
    WINDOWS_X64.iter().any(|release| release.version == version)
}

pub fn supports_build(version: &str, commit: &str) -> bool {
    WINDOWS_X64
        .iter()
        .any(|release| release.matches(version, commit))
}

impl VerifiedRelease {
    pub fn matches(&self, version: &str, commit: &str) -> bool {
        self.version == version && self.commit == commit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_and_different_builds_are_not_implicitly_verified() {
        assert!(supports_build(latest().version, latest().commit));
        assert!(!supports_build("3.30.8", latest().commit));
        assert!(!supports_build(latest().version, "different-build"));
    }
}
