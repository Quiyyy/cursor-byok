//! Compiles stable Prompt specifications for Cursor modes.
use std::{collections::BTreeMap, path::PathBuf};

use crate::{
    model::{ModelSpec, PromptSpec, ToolDefinition},
    Error, Result,
};

use super::{assets::runtime_expression, Mode, PromptAssets};

#[derive(Clone)]
pub struct PromptCompiler {
    assets: PromptAssets,
    fixture_file: Option<PathBuf>,
    native: Option<crate::cursor::native::NativeRuntime>,
    native_run: Option<crate::cursor::native::NativeRun>,
}

impl PromptCompiler {
    pub fn new(assets: PromptAssets) -> Self {
        Self {
            assets,
            fixture_file: None,
            native: None,
            native_run: None,
        }
    }

    /// Explicit fixture source for deterministic projection tests; never an application fallback.
    pub fn from_fixture_file(path: PathBuf) -> Result<Self> {
        let assets = PromptAssets::with_fixture_file(&path)?;
        Ok(Self {
            assets,
            fixture_file: Some(path),
            native: None,
            native_run: None,
        })
    }

    pub fn native(runtime: crate::cursor::native::NativeRuntime) -> Result<Self> {
        let mut compiler = Self::new(PromptAssets::native_templates()?);
        compiler.native = Some(runtime);
        Ok(compiler)
    }
    pub async fn for_run(
        &self,
        mode: Mode,
        model_id: &str,
        context: &crate::cursor::protocol::proto::agent::v1::RequestContext,
        subagent: bool,
    ) -> Result<Self> {
        let Some(runtime) = &self.native else {
            return self.snapshot();
        };
        let mode_number = match mode {
            Mode::Ask => 2,
            Mode::Plan => 3,
            Mode::Debug => 4,
            Mode::Multitask => 7,
            _ => 1,
        };
        let run = runtime
            .open(model_id, mode_number, context, subagent)
            .await?;
        let mut compiler = self.clone();
        compiler.assets.apply_native(mode, &run.profile);
        compiler.native_run = Some(run);
        Ok(compiler)
    }
    pub fn native_run(&self) -> Option<crate::cursor::native::NativeRun> {
        self.native_run.clone()
    }

    /// Reload at a turn boundary; the returned snapshot is immutable for that run.
    pub fn snapshot(&self) -> Result<Self> {
        match &self.fixture_file {
            Some(path) => Ok(Self::new(PromptAssets::with_fixture_file(path)?)),
            None => Ok(self.clone()),
        }
    }

    pub fn runtime_message(&self, mode: Mode, values: &BTreeMap<&str, String>) -> Result<String> {
        render(&self.assets.mode(mode).runtime, values)
    }

    pub fn prompt_spec(
        &self,
        mode: Mode,
        model: &ModelSpec,
        dynamic_tools: &[ToolDefinition],
        suppress_subagent_progress: bool,
    ) -> Result<PromptSpec> {
        let mut tools = self.tools(mode, suppress_subagent_progress);
        let mut dynamic_tools = dynamic_tools.to_vec();
        dynamic_tools.sort_by(|left, right| left.name.cmp(&right.name));
        append_dynamic_tools(&mut tools, dynamic_tools)?;
        if !model.supports_image_generation {
            tools.retain(|tool| tool.name != "GenerateImage");
        }
        Ok(PromptSpec {
            instructions: self.assets.mode(mode).prompt.clone(),
            tools,
        })
    }

    fn tools(&self, mode: Mode, suppress_subagent_progress: bool) -> Vec<ToolDefinition> {
        let mut tools = self.assets.mode(mode).tools.clone();
        if mode == Mode::Subagent && suppress_subagent_progress {
            tools.retain(|tool| tool.name != "UpdateCurrentStep");
        }
        tools
    }
}

fn render(template: &str, values: &BTreeMap<&str, String>) -> Result<String> {
    let expression = runtime_expression();
    let mut output = String::with_capacity(template.len());
    let mut cursor = 0;
    for capture in expression.captures_iter(template) {
        let token = capture.get(0).expect("runtime template token");
        let name = &capture[1];
        let value = values
            .get(name)
            .ok_or_else(|| Error::Protocol(format!("runtime template value is missing: {name}")))?;
        output.push_str(&template[cursor..token.start()]);
        output.push_str(value);
        cursor = token.end();
    }
    output.push_str(&template[cursor..]);
    Ok(output.trim().to_string())
}

fn append_dynamic_tools(
    tools: &mut Vec<ToolDefinition>,
    additions: Vec<ToolDefinition>,
) -> Result<()> {
    for tool in additions {
        if tools.iter().any(|existing| existing.name == tool.name) {
            return Err(Error::Protocol(format!(
                "dynamic MCP tool conflicts with a mode tool: {}",
                tool.name
            )));
        }
        tools.push(tool);
    }
    Ok(())
}
