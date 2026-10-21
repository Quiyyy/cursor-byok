//! Checks the single model-independent Cursor protocol and turn-boundary updates.
use cursor_server::{
    cursor::prompting::{Mode, PromptAssets, PromptCompiler},
    model::ModelSpec,
};

fn protocol() -> serde_json::Value {
    serde_json::from_str(include_str!("../prompt/cursor/protocol.json")).unwrap()
}

#[test]
fn all_models_use_the_same_protocol() {
    let compiler = PromptCompiler::new(PromptAssets::embedded().unwrap());
    let mut first = ModelSpec::new("first-model");
    first.supports_image_generation = true;
    let mut second = ModelSpec::new("second-model");
    second.supports_image_generation = true;
    let first = compiler
        .prompt_spec(Mode::Agent, &first, &[], false)
        .unwrap();
    let second = compiler
        .prompt_spec(Mode::Agent, &second, &[], false)
        .unwrap();
    assert_eq!(first.tools, second.tools);
    assert_eq!(first.instructions, second.instructions);
    assert_eq!(first.tools.len(), 18);
    assert!(!first.tools.iter().any(|t| t.name.contains("Mcp")));
    assert!(!first.instructions.contains("Grok"));
    assert!(!first.instructions.contains("{{"));
}

#[test]
fn updated_protocol_applies_to_next_turn_without_changing_active_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("protocol.json");
    let mut data = protocol();
    std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let compiler = PromptCompiler::from_protocol_file(path.clone()).unwrap();
    let active = compiler.snapshot().unwrap();
    let model = ModelSpec::new("any-model");
    let before = active.prompt_spec(Mode::Agent, &model, &[], false).unwrap();
    data["instructions"] = "Updated unified Cursor instructions".into();
    std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let next = compiler
        .snapshot()
        .unwrap()
        .prompt_spec(Mode::Agent, &model, &[], false)
        .unwrap();
    assert_eq!(next.instructions, "Updated unified Cursor instructions");
    assert_eq!(
        active.prompt_spec(Mode::Agent, &model, &[], false).unwrap(),
        before
    );
    assert_eq!(before.tools, next.tools);
    std::fs::write(&path, b"{broken").unwrap();
    assert!(
        compiler.snapshot().is_err(),
        "invalid updates must not silently use old assets"
    );
}

#[test]
fn incomplete_or_ambiguous_protocol_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("protocol.json");
    let original = protocol();
    for invalid in ["missing", "duplicate", "unsupported", "version"] {
        let mut data = original.clone();
        match invalid {
            "missing" => {
                data["tools"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|t| t["name"] != "Read");
            }
            "duplicate" => {
                let duplicate = data["tools"][0].clone();
                data["tools"].as_array_mut().unwrap().push(duplicate);
            }
            "unsupported" => {
                let mut unknown = data["tools"][0].clone();
                unknown["name"] = "UnimplementedTool".into();
                data["tools"].as_array_mut().unwrap().push(unknown);
            }
            _ => {
                data["format_version"] = 999.into();
            }
        }
        std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(
            PromptCompiler::from_protocol_file(path.clone()).is_err(),
            "accepted {invalid}"
        );
    }
}
