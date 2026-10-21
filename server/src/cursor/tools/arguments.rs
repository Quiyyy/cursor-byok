//! Preserve integer semantics when native JSON Schema number fields arrive as 2.0.
use crate::{model::ToolCall, Error, Result};

pub(super) fn normalize(mut call: ToolCall) -> Result<ToolCall> {
    let fields: &[(&str, i64, i64)] = match call.name.as_str() {
        "Shell" => &[("block_until_ms", 0, i64::MAX)],
        "Grep" => &[
            ("-A", 0, i32::MAX as i64),
            ("-B", 0, i32::MAX as i64),
            ("-C", 0, i32::MAX as i64),
            ("head_limit", 0, i32::MAX as i64),
            ("offset", 0, i32::MAX as i64),
        ],
        "Read" => &[
            ("offset", i32::MIN as i64, i32::MAX as i64),
            ("limit", 0, u32::MAX as i64),
        ],
        "EditNotebook" => &[("cell_idx", 0, u32::MAX as i64)],
        _ => &[],
    };
    for &(key, min, max) in fields {
        let Some(value) = call.arguments.get(key) else {
            continue;
        };
        let invalid = || {
            Error::Protocol(format!(
                "{} {key} must be an integer in {min}..={max}",
                call.name
            ))
        };
        let out_of_range = || {
            Error::Protocol(format!(
                "{} {key} is out of range ({min}..={max})",
                call.name
            ))
        };
        let integer = match value.as_i64() {
            Some(integer) => integer,
            None => {
                let number = value.as_f64().ok_or_else(invalid)?;
                if !number.is_finite() || number.fract() != 0.0 {
                    return Err(invalid());
                }
                if number < min as f64 || number >= i64::MAX as f64 {
                    return Err(out_of_range());
                }
                number as i64
            }
        };
        if integer < min || integer > max {
            return Err(out_of_range());
        }
        call.arguments
            .as_object_mut()
            .expect("field belongs to object")
            .insert(key.into(), integer.into());
    }
    Ok(call)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn call(name: &str, arguments: serde_json::Value) -> ToolCall {
        ToolCall {
            name: name.into(),
            arguments,
            index: 0,
            call_id: "c".into(),
            model_call_id: "m".into(),
            arguments_text: String::new(),
            argument_error: None,
        }
    }
    #[test]
    fn native_numbers_retain_values_and_reject_lossy_conversion() {
        for (name, key) in [
            ("Shell", "block_until_ms"),
            ("Grep", "-C"),
            ("Read", "limit"),
            ("EditNotebook", "cell_idx"),
        ] {
            let normalized = normalize(call(name, json!({key:2.0}))).unwrap();
            assert_eq!(normalized.arguments[key].as_i64(), Some(2));
            for value in [json!(1.5), json!(-1), json!("2"), json!(1e30)] {
                assert!(normalize(call(name, json!({key:value}))).is_err());
            }
        }
        assert_eq!(
            normalize(call("Read", json!({"offset":-2.0})))
                .unwrap()
                .arguments["offset"],
            -2
        );
        assert!(normalize(call("Grep", json!({"head_limit":4294967296u64}))).is_err());
    }
}
