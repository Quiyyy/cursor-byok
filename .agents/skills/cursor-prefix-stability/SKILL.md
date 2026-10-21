---
name: cursor-prefix-stability
description: Implement and review native Cursor routing and stateless provider protocol translation while preserving model request prefixes, signed replay data, and conversation identity.
---

# Cursor prefix stability

Cursor owns prompts, request context, conversation history, checkpoints, tools, and compaction. Preserve that ownership; do not recreate a history store, state container, tool loop, or prompt compiler in BYOK.

```text
server/
├── native-agent/route.cjs        Native Host state and real model identity enter LocalAgentClient
├── src/local_app/native_agent.rs Installation lifecycle and native model catalog cache
├── src/api/byok/                Stateless model HTTP transport and protocol translation
├── src/provider/                Provider-specific serialization and request recording
└── src/plugin/                  Account and provider SDK transport
```

## Required invariants

- Unchanged native request history must retain an exact structural prefix across ordinary tool rounds and user turns. Explicit native compaction or a model change can reset that prefix; do not manufacture a reset in the gateway.
- Native system instructions and tool definitions come from installed Cursor factories. The native menu may be enriched with explicit provider-advertised reasoning choices and BYOK context budgets; never maintain a per-family capability table, prompt copy, or substitute another model ID to force a family. Refresh the native provider metadata cache each Run, including when the context limit increases.
- Pass the Host's state, resources, blob store, action manager, checkpoint handler, interaction listener, and MCP tools by reference. Only route model requests; do not intercept tool execution or automatically approve interactions.
- Keep stable native conversation and generation identifiers in the model gateway. Per-call log IDs must not become the conversation cache key.
- Treat each gateway request independently. Protocol conversion must preserve signed reasoning, text/custom tool inputs, tool-call identities, tool results, and ordering without editing earlier messages.
- The same-protocol path forwards native payloads; configured defaults must preserve explicitly supplied values. Configured templates must use a stable conversation identifier.
- Context limits are integer token counts owned by BYOK model settings for both API and account models. At each Run, replace stale per-chat context parameters with the configured count, or remove them when reset to the native default. Preserve other native parameters and all Host state. Never send display units such as `200k` into native parameters parsed with `parseInt`.
- Cached model catalogs invalidate on metadata or installed-runtime changes. Reuse the native picker and protobuf factories rather than maintaining a second capability table.

## Workflow and verification

Use TDD for changes affecting these boundaries. Trace the full path:

```text
Cursor UI → original Agent Host → route → native LocalAgentClient
  → model HTTP request → BYOK gateway → provider / plugin → response stream
  → native tool loop, checkpoints and UI
```

Check exact history prefixes and stable cache identifiers, not only token estimates. Test native tool input formats, signed Responses replay, system/developer messages, model parameters, route isolation, cancellation, and installation restoration as applicable. Ordinary unit tests do not prove real IDE behavior.

```sh
node --test server/native-agent/native.test.mjs
node server/native-agent/build.mjs --check
cargo test -p cursor-server --test external_api
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

For integration changes, verify an isolated Cursor installation and profile with the actual desktop build. Record real-provider tests separately from deterministic provider fixtures. Do not mark every native tool, platform, or interrupted background task as verified from a small successful file-edit task.
