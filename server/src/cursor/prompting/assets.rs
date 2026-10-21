//! Loads runtime templates and explicit protocol test fixtures.
use std::{path::Path, sync::OnceLock};

use crate::{model::ToolDefinition, Error, Result};

use super::catalog::Catalog;
use super::protocol::NativeProtocol;

static FIXTURE_PROTOCOL: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/tests/fixtures/cursor");

static EMBEDDED_PROMPTS: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/prompt/cursor");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mode {
    Agent,
    Ask,
    Plan,
    Debug,
    Multitask,
    Subagent,
    Compaction,
}

impl Mode {
    pub fn parse(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "agent" => Ok(Self::Agent),
            "ask" => Ok(Self::Ask),
            "plan" => Ok(Self::Plan),
            "debug" => Ok(Self::Debug),
            "multitask" => Ok(Self::Multitask),
            "subagent" => Ok(Self::Subagent),
            "compaction" => Ok(Self::Compaction),
            other => Err(Error::Config(format!("unknown prompt mode: {other}"))),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Ask => "ask",
            Self::Plan => "plan",
            Self::Debug => "debug",
            Self::Multitask => "multitask",
            Self::Subagent => "subagent",
            Self::Compaction => "compaction",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Agent => 0,
            Self::Ask => 1,
            Self::Plan => 2,
            Self::Debug => 3,
            Self::Multitask => 4,
            Self::Subagent => 5,
            Self::Compaction => 6,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ModeAssets {
    pub prompt: String,
    pub runtime: String,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Clone, Debug)]
pub struct PromptAssets {
    modes: [ModeAssets; 7],
}

impl PromptAssets {
    pub(super) fn native_templates() -> Result<Self> {
        let read = |path: &str| {
            EMBEDDED_PROMPTS
                .get_file(path)
                .and_then(|f| f.contents_utf8())
                .map(str::to_string)
                .ok_or_else(|| Error::Config(format!("missing native runtime template: {path}")))
        };
        let extensions: Vec<ToolDefinition> = serde_json::from_str(&read("extensions.json")?)?;
        let mut modes = Vec::new();
        for mode in [
            Mode::Agent,
            Mode::Ask,
            Mode::Plan,
            Mode::Debug,
            Mode::Multitask,
            Mode::Subagent,
            Mode::Compaction,
        ] {
            let runtime = read(&format!("{}/runtime.md", mode.name()))?;
            validate_runtime_template(mode, &runtime)?;
            modes.push(ModeAssets {
                prompt: if mode == Mode::Compaction {
                    read("compaction/prompt.md")?
                } else {
                    String::new()
                },
                runtime,
                tools: extensions
                    .iter()
                    .filter(|t| {
                        mode != Mode::Compaction
                            && (t.name != "UpdateCurrentStep" || mode == Mode::Subagent)
                    })
                    .cloned()
                    .collect(),
            });
        }
        Ok(Self {
            modes: modes
                .try_into()
                .map_err(|_| Error::Config("invalid mode count".into()))?,
        })
    }
    pub(super) fn apply_native(
        &mut self,
        mode: Mode,
        profile: &crate::cursor::native::NativeProfile,
    ) {
        let assets = &mut self.modes[mode.index()];
        assets.prompt = profile.instructions.clone();
        let extensions = std::mem::take(&mut assets.tools);
        assets.tools = profile.tools.clone();
        assets.tools.extend(extensions);
    }
    /// Fixed protocol sample for tests that do not have an installed Cursor.
    pub fn fixture() -> Result<Self> {
        Self::embedded_with_protocol(None)
    }

    pub fn with_fixture_file(path: &Path) -> Result<Self> {
        let protocol = std::fs::read_to_string(path)?;
        Self::embedded_with_protocol(Some(&protocol))
    }

    fn embedded_with_protocol(protocol: Option<&str>) -> Result<Self> {
        Self::read(|path| {
            if path == "protocol.json" {
                if let Some(protocol) = protocol {
                    return Ok(Some(protocol.into()));
                }
            }
            FIXTURE_PROTOCOL
                .get_file(path)
                .or_else(|| EMBEDDED_PROMPTS.get_file(path))
                .map(|file| {
                    file.contents_utf8()
                        .map(str::to_string)
                        .ok_or_else(|| Error::Config(format!("prompt asset is not UTF-8: {path}")))
                })
                .transpose()
        })
    }

    fn read(mut asset: impl FnMut(&str) -> Result<Option<String>>) -> Result<Self> {
        let protocol = NativeProtocol::parse(
            &asset("protocol.json")?
                .ok_or_else(|| Error::Config("missing Cursor protocol.json".into()))?,
        )?;
        let mut tools = protocol.tools;
        let extensions: Vec<ToolDefinition> = serde_json::from_str(
            &asset("extensions.json")?
                .ok_or_else(|| Error::Config("missing Cursor extensions.json".into()))?,
        )?;
        tools.extend(extensions);
        let catalog = Catalog::new(tools)?;
        let mut modes = Vec::with_capacity(7);
        for mode in [
            Mode::Agent,
            Mode::Ask,
            Mode::Plan,
            Mode::Debug,
            Mode::Multitask,
            Mode::Subagent,
            Mode::Compaction,
        ] {
            let prompt = if mode == Mode::Compaction {
                asset("compaction/prompt.md")?
                    .ok_or_else(|| Error::Config("missing compaction prompt".into()))?
            } else {
                protocol.instructions.clone()
            };
            let runtime = asset(&format!("{}/runtime.md", mode.name()))?
                .ok_or_else(|| Error::Config(format!("missing runtime template for {mode:?}")))?;
            validate_runtime_template(mode, &runtime)?;
            let manifest = asset(&format!("modes/{}.json", mode.name()))?
                .ok_or_else(|| Error::Config(format!("missing manifest for {mode:?}")))?;
            let tools = catalog.select_json(&manifest)?;
            modes.push(ModeAssets {
                prompt,
                runtime,
                tools,
            });
        }
        Ok(Self {
            modes: modes
                .try_into()
                .map_err(|_| Error::Config("incomplete Cursor prompt mode catalog".into()))?,
        })
    }

    pub fn mode(&self, mode: Mode) -> &ModeAssets {
        &self.modes[mode.index()]
    }
}

const RUNTIME_VARIABLES: &[&str] = &[
    "OPEN_FILES",
    "SELECTED_CONTEXT",
    "ACTION_CONTEXT",
    "TIMESTAMP",
    "USER_QUERY",
    "DEBUG_SERVER_ENDPOINT",
    "DEBUG_LOG_PATH",
    "DEBUG_SESSION_ID",
];

fn validate_runtime_template(mode: Mode, template: &str) -> Result<()> {
    let expression = runtime_expression();
    for capture in expression.captures_iter(template) {
        let name = &capture[1];
        if !RUNTIME_VARIABLES.contains(&name) {
            return Err(Error::Config(format!(
                "unknown variable in {mode:?} runtime template: {name}"
            )));
        }
    }
    for required in ["TIMESTAMP", "USER_QUERY"] {
        let token = format!("{{{{{required}}}}}");
        if !template.contains(&token) {
            return Err(Error::Config(format!(
                "{mode:?} runtime template is missing {token}"
            )));
        }
    }
    let stripped = expression.replace_all(template, "");
    if stripped.contains("{{") || stripped.contains("}}") {
        return Err(Error::Config(format!(
            "malformed placeholder in {mode:?} runtime template"
        )));
    }
    Ok(())
}

pub(super) fn runtime_expression() -> &'static regex::Regex {
    static EXPRESSION: OnceLock<regex::Regex> = OnceLock::new();
    EXPRESSION.get_or_init(|| {
        regex::Regex::new(r"\{\{([A-Z_]+)\}\}").expect("valid runtime placeholder expression")
    })
}
