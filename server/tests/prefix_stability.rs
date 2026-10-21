//! Verifies append-only provider history and stable prompt prefixes.
#[path = "support/fixtures.rs"]
mod fixtures;

use std::collections::BTreeMap;

use cursor_server::{
    cursor::prompting::{Mode, PromptAssets, PromptCompiler},
    model::{project_messages, ProjectedContent},
    model::{
        CanonicalMessage, MessageContent, ModelSpec, Origin, Role, ToolCallContent, ToolDefinition,
        ToolResultContent,
    },
};

#[test]
fn projecting_an_append_only_context_preserves_the_complete_prefix() {
    let first = vec![fixtures::user("u1", "one")];
    let mut second = first.clone();
    second.push(fixtures::user("u2", "two"));
    let projected_first = project_messages(&first).unwrap();
    let projected_second = project_messages(&second).unwrap();
    assert_eq!(projected_first, projected_second[..projected_first.len()]);
}

#[test]
fn every_tool_result_is_projected_as_string_content() {
    let object = serde_json::json!({"merge": false, "todos": []});
    let messages = vec![
        tool_result("object", object.clone()),
        tool_result("string", serde_json::Value::String("plain text".into())),
    ];
    let projected = project_messages(&messages).unwrap();

    let ProjectedContent::ToolResult(object_result) = &projected[0].content else {
        panic!("expected tool result")
    };
    let object_text = &object_result.content;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(object_text).unwrap(),
        object
    );
    let ProjectedContent::ToolResult(string_result) = &projected[1].content else {
        panic!("expected tool result")
    };
    assert_eq!(string_result.content, "plain text");
}

#[test]
fn projected_tool_result_prefixes_remain_stable() {
    let first = vec![named_tool_result("Grep", &"x".repeat(64 * 1024))];
    let mut second = first.clone();
    second.push(fixtures::user("u2", "continue"));

    let projected_first = project_messages(&first).unwrap();
    let projected_second = project_messages(&second).unwrap();

    assert_eq!(projected_first, projected_second[..projected_first.len()]);
}

#[test]
fn unbounded_tool_results_are_not_rewritten() {
    let original = "x".repeat(64 * 1024);
    let projected = project_messages(&[named_tool_result("Delete", &original)]).unwrap();
    let ProjectedContent::ToolResult(result) = &projected[0].content else {
        panic!("expected tool result")
    };
    assert_eq!(result.content, original);
}

#[test]
fn assistant_text_and_thinking_remain_separate_during_projection() {
    let messages = vec![CanonicalMessage {
        message_id: "assistant".into(),
        role: Role::Assistant,
        origin: Origin::Assistant,
        content: MessageContent::Assistant {
            text: "visible answer".into(),
            thinking: "private reasoning".into(),
            tool_round_id: Some("round".into()),
            replay_state: None,
            tool_calls: Vec::new(),
        },
        runtime_event_id: None,
    }];

    let projected = project_messages(&messages).unwrap();
    let ProjectedContent::Assistant { text, thinking, .. } = &projected[0].content else {
        panic!("expected assistant")
    };
    assert_eq!(text, "visible answer");
    assert_eq!(thinking, "private reasoning");
}

#[test]
fn split_tool_pairs_reconstruct_the_original_provider_assistant_message() {
    let messages = vec![
        assistant_tool_pair(
            "assistant-second",
            "model-call",
            1,
            "call-second",
            "visible answer",
            "complete reasoning",
        ),
        tool_result_with_call("result-second", "call-second", "second"),
        assistant_tool_pair("assistant-first", "model-call", 0, "call-first", "", ""),
        tool_result_with_call("result-first", "call-first", "first"),
    ];

    let projected = project_messages(&messages).unwrap();

    assert_eq!(projected.len(), 3);
    assert_eq!(projected[0].role, Role::Assistant);
    let ProjectedContent::Assistant {
        thinking, calls, ..
    } = &projected[0].content
    else {
        panic!("expected assistant")
    };
    assert_eq!(thinking, "complete reasoning");
    assert_eq!(calls[0].call_id, "call-first");
    assert_eq!(calls[1].call_id, "call-second");
    let ProjectedContent::ToolResult(second) = &projected[1].content else {
        panic!("expected tool result")
    };
    let ProjectedContent::ToolResult(first) = &projected[2].content else {
        panic!("expected tool result")
    };
    assert_eq!(second.call_id, "call-second");
    assert_eq!(first.call_id, "call-first");
}

#[test]
fn every_mode_uses_the_shared_extracted_contract() {
    let assets = PromptAssets::fixture().unwrap();
    let native: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/cursor/protocol.json")).unwrap();
    let tools: Vec<ToolDefinition> = serde_json::from_value(native["tools"].clone()).unwrap();
    for mode in [
        Mode::Agent,
        Mode::Ask,
        Mode::Plan,
        Mode::Debug,
        Mode::Multitask,
        Mode::Subagent,
    ] {
        assert_eq!(
            assets.mode(mode).prompt,
            native["instructions"].as_str().unwrap()
        );
        for tool in &assets.mode(mode).tools {
            assert!(!tool.name.contains("Mcp"));
            if !tool.name.starts_with("Semble") && tool.name != "UpdateCurrentStep" {
                assert_eq!(
                    Some(tool),
                    tools.iter().find(|native| native.name == tool.name)
                );
            }
        }
    }
    assert!(assets.mode(Mode::Compaction).tools.is_empty());
    assert!(assets
        .mode(Mode::Plan)
        .tools
        .iter()
        .any(|t| t.name == "CreatePlan"));
    assert!(!assets
        .mode(Mode::Agent)
        .tools
        .iter()
        .any(|t| t.name == "CreatePlan"));
}

#[test]
fn every_captured_mode_owns_and_renders_its_runtime_template() {
    let compiler = PromptCompiler::new(PromptAssets::fixture().unwrap());
    let values = BTreeMap::from([
        ("OPEN_FILES", String::new()),
        ("SELECTED_CONTEXT", String::new()),
        ("ACTION_CONTEXT", String::new()),
        ("TIMESTAMP", "Sunday, Aug 16, 2026, 11:31 PM (UTC+8)".into()),
        ("USER_QUERY", "question".into()),
        ("DEBUG_SERVER_ENDPOINT", "http://debug".into()),
        ("DEBUG_LOG_PATH", "/tmp/debug.log".into()),
        ("DEBUG_SESSION_ID", "session".into()),
    ]);
    for (mode, marker) in [
        (Mode::Agent, "You are still in **Agent Mode**"),
        (Mode::Ask, "Ask mode is active."),
        (Mode::Plan, "Plan mode is active."),
        (Mode::Debug, "You are now in **DEBUG MODE**"),
        (Mode::Multitask, "The user has engaged **Multitask Mode**"),
    ] {
        let rendered = compiler.runtime_message(mode, &values).unwrap();
        assert!(rendered.contains(marker), "missing {mode:?} marker");
        assert!(rendered.contains("<user_query>\nquestion\n</user_query>"));
        assert_eq!(rendered.matches("<user_query>").count(), 1);
    }
}

#[test]
fn dynamic_mcp_tools_are_appended_after_the_stable_mode_tool_prefix() {
    let assets = PromptAssets::fixture().unwrap();
    let compiler = PromptCompiler::new(assets);
    let base = compiler
        .prompt_spec(Mode::Agent, &ModelSpec::new("model"), &[], false)
        .unwrap();
    let dynamic = compiler
        .prompt_spec(
            Mode::Agent,
            &ModelSpec::new("model"),
            &[ToolDefinition {
                input_format: None,
                name: "mcp_repo_lookup".into(),
                description: "lookup".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            false,
        )
        .unwrap();
    assert_eq!(base.tools, dynamic.tools[..base.tools.len()]);
    assert_eq!(dynamic.tools.last().unwrap().name, "mcp_repo_lookup");
}

#[test]
fn dynamic_mcp_tool_cannot_replace_a_mode_tool() {
    let assets = PromptAssets::fixture().unwrap();
    let compiler = PromptCompiler::new(assets);
    let error = compiler
        .prompt_spec(
            Mode::Agent,
            &ModelSpec::new("model"),
            &[ToolDefinition {
                input_format: None,
                name: "Read".into(),
                description: "replacement".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            false,
        )
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("dynamic MCP tool conflicts with a mode tool: Read"));
}

#[test]
fn image_generation_capability_controls_only_the_generate_image_definition() {
    let assets = PromptAssets::fixture().unwrap();
    let compiler = PromptCompiler::new(assets);
    let without = compiler
        .prompt_spec(Mode::Agent, &ModelSpec::new("model"), &[], false)
        .unwrap();
    let mut model = ModelSpec::new("model");
    model.supports_image_generation = true;
    let with = compiler
        .prompt_spec(Mode::Agent, &model, &[], false)
        .unwrap();

    assert!(!without
        .tools
        .iter()
        .any(|tool| tool.name == "GenerateImage"));
    assert!(with.tools.iter().any(|tool| tool.name == "GenerateImage"));
    assert_eq!(with.tools.len(), without.tools.len() + 1);
}

#[test]
fn agent_system_prompt_is_static_and_independent_of_model_name() {
    let assets = PromptAssets::fixture().unwrap();
    let compiler = PromptCompiler::new(assets);
    let mut model = ModelSpec::new("test-model-hash");
    model.display_name = Some("Test Model".into());
    let request = compiler
        .prompt_spec(Mode::Agent, &model, &[], false)
        .unwrap();
    let prompt = &request.instructions;
    assert!(prompt.contains("powered by the configured model"));
    assert!(!prompt.contains("Test Model"));
    assert!(!prompt.contains("test-model-hash"));
    assert!(!prompt.contains("{{FAKE_MODEL_NAME}}"));
    assert!(!prompt.contains("<user_info>"));
}

#[test]
fn subagent_uses_the_agent_prompt_and_only_the_captured_tool_delta() {
    let assets = PromptAssets::fixture().unwrap();
    let compiler = PromptCompiler::new(assets);
    let agent_prompt = compiler
        .prompt_spec(Mode::Agent, &ModelSpec::new("model"), &[], false)
        .unwrap();
    let subagent_prompt = compiler
        .prompt_spec(Mode::Subagent, &ModelSpec::new("model"), &[], false)
        .unwrap();
    assert_eq!(agent_prompt.instructions, subagent_prompt.instructions);

    let request = compiler
        .prompt_spec(Mode::Subagent, &ModelSpec::new("model"), &[], false)
        .unwrap();
    assert_eq!(
        request
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "Shell",
            "Grep",
            "Delete",
            "WebSearch",
            "WebFetch",
            "ReadLints",
            "EditNotebook",
            "TodoWrite",
            "StrReplace",
            "Write",
            "Read",
            "Glob",
            "SwitchMode",
            "UpdateCurrentStep",
            "SembleSearch",
            "SembleFindRelated",
        ]
    );
    assert!(!request.tools.iter().any(|tool| tool.name == "Task"));

    let suppressed = compiler
        .prompt_spec(Mode::Subagent, &ModelSpec::new("model"), &[], true)
        .unwrap();
    assert!(!suppressed
        .tools
        .iter()
        .any(|tool| tool.name == "UpdateCurrentStep"));
}

fn tool_result(id: &str, output: serde_json::Value) -> CanonicalMessage {
    tool_result_with_call(id, &format!("call-{id}"), output)
}

fn tool_result_with_call(
    id: &str,
    call_id: &str,
    output: impl Into<serde_json::Value>,
) -> CanonicalMessage {
    let output = output.into();
    CanonicalMessage {
        message_id: id.into(),
        role: Role::Tool,
        origin: Origin::Tool,
        content: MessageContent::ToolResult(ToolResultContent {
            call_id: call_id.into(),
            name: "Tool".into(),
            content: output
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| output.to_string()),
            is_error: false,
            image: None,
            provider_parts: Vec::new(),
        }),
        runtime_event_id: None,
    }
}

fn named_tool_result(name: &str, output: &str) -> CanonicalMessage {
    CanonicalMessage {
        message_id: format!("result-{name}"),
        role: Role::Tool,
        origin: Origin::Tool,
        content: MessageContent::ToolResult(ToolResultContent {
            call_id: format!("call-{name}"),
            name: name.into(),
            content: output.into(),
            is_error: false,
            image: None,
            provider_parts: Vec::new(),
        }),
        runtime_event_id: None,
    }
}

fn assistant_tool_pair(
    id: &str,
    tool_round_id: &str,
    index: usize,
    call_id: &str,
    text: &str,
    thinking: &str,
) -> CanonicalMessage {
    CanonicalMessage {
        message_id: id.into(),
        role: Role::Assistant,
        origin: Origin::Assistant,
        content: MessageContent::Assistant {
            text: text.into(),
            thinking: thinking.into(),
            tool_round_id: Some(tool_round_id.into()),
            replay_state: None,
            tool_calls: vec![ToolCallContent {
                index,
                call_id: call_id.into(),
                name: "Tool".into(),
                arguments: serde_json::json!({}),
            }],
        },
        runtime_event_id: None,
    }
}
