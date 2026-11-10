# API Integrations

## Connection Types

The active AI provider is controlled by the `connection_type` preference. Possible values:

| `connection_type` value | Provider |
|------------------------|----------|
| `chatgpt_web` | ChatGPT Web (no API key, opens browser window) |
| `chatgpt_api` | OpenAI API (ChatGPT via API key) |
| `ollama_api` | Ollama (self-hosted LLM) |
| `openai_comp_api` | OpenAI-compatible API |
| `google_gemini_api` | Google Gemini API |
| `anthropic_api` | Claude (Anthropic) API |
| `mistral_api` | Mistral AI API (native, incl. Mistral Studio agents) |

The global default is `chatgpt_web`. Each special prompt (`add_tags`, `spamfilter`, etc.) can independently override this via its own `{prefix}_connection_type` pref.

## Provider Configuration

Each provider has its own settings block in `integration_options_config` (`options/mzta-options-default.js`):

### ChatGPT Web
Controlled via `js/mzta-chatgpt.js`. Opens a browser window to `chatgpt.com`, injects the prompt via DOM automation, and reads back the response. Settings: `chatgpt_web_model`, `chatgpt_web_tempchat`, `chatgpt_web_project`, `chatgpt_web_custom_gpt`, `chatgpt_web_load_wait_time`.

Content script `js/lib/diff.js` is injected into ChatGPT pages for diff-view support.

### OpenAI API (`chatgpt_api`)
- Module: `js/api/openai_responses.js`
- Worker: `js/workers/model-worker-openai_responses.js`
- Settings keys: `chatgpt_api_key`, `chatgpt_model`, `chatgpt_developer_messages`, `chatgpt_temperature`, `chatgpt_store`

### Ollama (`ollama_api`)
- Module: `js/api/ollama.js`
- Worker: `js/workers/model-worker-ollama.js`
- Settings keys: `ollama_host`, `ollama_model`, `ollama_num_ctx`, `ollama_temperature`, `ollama_think`, `ollama_format_json`
- Requires CORS to be configured on the Ollama server

### OpenAI-Compatible (`openai_comp_api`)
- Module: `js/api/openai_comp.js`
- Worker: `js/workers/model-worker-openai_comp.js`
- Settings keys: `openai_comp_host`, `openai_comp_model`, `openai_comp_api_key`, `openai_comp_use_v1`, `openai_comp_chat_name`, `openai_comp_temperature`
- Pre-configured providers: `js/api/openai_comp_configs.js` (DeepSeek, Grok, Mistral, OpenRouter, Perplexity)

### Google Gemini (`google_gemini_api`)
- Module: `js/api/google_gemini.js`
- Worker: `js/workers/model-worker-google_gemini.js`
- Settings keys: `google_gemini_api_key`, `google_gemini_model`, `google_gemini_system_instruction`, `google_gemini_thinking_budget`, `google_gemini_temperature`

### Anthropic / Claude (`anthropic_api`)
- Module: `js/api/anthropic.js`
- Worker: `js/workers/model-worker-anthropic.js`
- Settings keys: `anthropic_api_key`, `anthropic_model`, `anthropic_version`, `anthropic_max_tokens`, `anthropic_system_prompt`, `anthropic_temperature`, `anthropic_extended_thinking_budget`
- **Extended thinking**: when `anthropic_extended_thinking_budget > 0`, the request body adds `thinking: { type: 'enabled', budget_tokens: N }` and **omits** `temperature` (the Claude API forbids setting temperature with extended thinking). Thinking output arrives in the SSE stream as `content_block_delta` events with `delta.type === 'thinking_delta'` and is forwarded to the webchat UI as `newThinkingToken` messages, captured into a `thinkingAccumulator` in the worker and passed on `tokensDone`.

### Mistral AI (`mistral_api`)
- Module: `js/api/mistral.js`
- Worker: `js/workers/model-worker-mistral.js`
- Settings keys: `mistral_api_key`, `mistral_model` (default `mistral-medium-latest`), `mistral_temperature`, `mistral_max_tokens` (0 = model default), `mistral_system_prompt`, `mistral_reasoning_effort` (`''` = not sent, `none`/`low`/`medium`/`high`), `mistral_safe_prompt`, `mistral_agent_id`, `mistral_agent_version`
- Host permission: `https://*.mistral.ai/*` (requested when fetching models/agents, in the onboarding page and from the popup banner)
- Wire format verified against the official `@mistralai/mistralai` SDK (v3.5.0, November 2026).
- **Chat Completions** (default): `POST https://api.mistral.ai/v1/chat/completions` with `stream: true`; the system prompt is prepended as a `system` message; `response_format: { type: 'json_object' }` when the caller sets `json_mode`. Streaming deltas have `choices[0].delta.content` as a string or an array of chunks (`{type:'text'}`, `{type:'thinking', thinking:[{type:'text'}]}`); thinking is forwarded as `newThinkingToken`.
- **Models**: `GET /v1/models`, filtered to `capabilities.completion_chat`, deprecated models dropped, `-latest` aliases first, reasoning models marked.
- **Mistral Studio agents**: when `mistral_agent_id` is set the worker uses the **Conversations API** `POST /v1/conversations` with `agent_id`, optional `agent_version` (number or alias such as `production`), `store: false` and the full history as `inputs` entries (`message.input` / `message.output`), so Mistral keeps no conversation. JSON mode is requested with `completion_args.response_format`. The agent's own model, instructions and tools are used (model, temperature and system prompt settings are ignored). Stream events: `conversation.response.started`, `message.output.delta` (text, `tool_reference` sources, thinking), `tool.execution.started/done`, `conversation.response.error`, `conversation.response.done`. Tool use and sources are sent as thinking tokens, never as answer text. Agents are listed with `GET /v1/agents`, aliases with `GET /v1/agents/{id}/aliases`.
- Rate limits and transient errors (429, 5xx) are retried up to 3 times (`Retry-After` honored, otherwise exponential backoff).
- `mzta_specialCommand` accepts `json_mode` (passed to the worker in the `chatMessage` event; other workers ignore it) and has `terminate()`.

## Thinking output in the webchat UI

Two provider categories emit reasoning/thinking content:

- **Ollama / OpenAI Compatible**: thinking arrives inline in the normal token stream wrapped in `<think>…</think>` tags. `MessagesArea.flushAccumulatingMessage()` strips these blocks from the rendered text and renders them as a `<details class="thinking-block">` prepended to the answer. If an unterminated `<think>` is detected mid-stream, the flush is deferred until the closing tag arrives.
- **Anthropic** and **Mistral AI**: thinking is captured in the worker and posted to the controller as `newThinkingToken` (for Mistral agents also tool use and sources). `MessagesArea` accumulates it and renders the same `<details>` block on final flush.

The global `hide_thinking` pref (default `true`) controls the **initial open/collapsed state** of the thinking block: `true` → collapsed, `false` → open. The user can always toggle by clicking. Thinking content is never discarded. Other providers (Google Gemini, OpenAI Responses, ChatGPT Web) are not affected by this UI logic.

## Configuration Validation

For special prompts (`mzta_specialCommand`), required fields are validated in `initWorker()` (`js/mzta-special-commands.js`) **before** the worker is created. If a required field is empty, an `Error` with `isConfigError = true` is thrown. Validation covers:

| Provider | Required fields |
|----------|----------------|
| `chatgpt_api` | `chatgpt_api_key`, `chatgpt_model` |
| `google_gemini_api` | `google_gemini_api_key`, `google_gemini_model` |
| `ollama_api` | `ollama_host`, `ollama_model` |
| `openai_comp_api` | `openai_comp_host`, `openai_comp_model` |
| `anthropic_api` | `anthropic_api_key`, `anthropic_model`, `anthropic_version` |
| `mistral_api` | `mistral_api_key`, and `mistral_model` unless `mistral_agent_id` is set |

Validation is skipped when `use_specific_api = true` (i.e., the prompt's own `api_type` overrides the global setting — credentials come from the prompt config, not global prefs).

The `isConfigError` flag on the thrown error tells callers in `mzta-background.js` to display the error in the panel **without saving it to storage** — so the user can fix settings and retry cleanly.

Feature-specific routing of `isConfigError`:

- `summarize` / `translate` / `spamfilter`: the error is shown in their dedicated panel (summary / translation / spam panel) and **not** persisted to storage.
- `add_tags`: it has **no dedicated panel**, so the error is routed to the **generic error panel** via `showGenericError(errMsg, source)` in `mzta-background.js`, which broadcasts a `showGenericError` message to all tabs. The content script `js/mzta-compose-script.js` renders it as `#mzta-generic-error` inside `#mzta-container`. The panel is dismissible and reusable by any future feature without its own UI.

For regular prompts (`openChatGPT()`), all API integrations share `openAPIWebchat()` in `mzta-background.js`: it opens `api_webchat/index.html?llm=<connection_type>&call_id=_<integration>_<id>`, waits for `<connection_type>_ready_<call_id>`, validates the configuration with the same `validateAPIConfig()` used by special commands (taking the prompt specific API settings into account when the prompt overrides the API) and sends `api_send`, or `api_error` with the validation message.

## Web Worker Pattern

For all API-based providers (everything except ChatGPT Web), the call goes through a Web Worker:

```
mzta-background.js
  → creates new Worker('js/workers/model-worker-<provider>.js')
  → postMessage({ prompt, settings })
  → worker makes HTTP fetch to provider API
  → worker postMessage({ result }) back
  → background handles result
```

This keeps API calls off the main thread and avoids blocking the Thunderbird UI.

## Optional Permissions

API calls require host permissions. These are declared as `optional_permissions` in `manifest.json` and requested at runtime:

- `https://*.chatgpt.com/*` and `https://*.openai.com/*` for ChatGPT
- `https://*.anthropic.com/*` for Claude
- `https://*.mistral.ai/*` for Mistral AI
- `https://*/*` and `http://*/*` for Ollama and OpenAI-compatible endpoints

## Adding a New Provider

1. Create `js/api/<provider>.js` with the API call logic
2. Create `js/workers/model-worker-<provider>.js` that imports and calls the API module
3. Add a new `connection_type` value constant
4. Add settings keys to `integration_options_config` in `options/mzta-options-default.js`
5. Add UI controls to `options/mzta-options.html` and `options/mzta-options.js`
6. Add the new `connection_type` case to the dispatch logic in `mzta-background.js`
7. Add required host permissions to `manifest.json` optional_permissions
8. Add i18n strings to `_locales/en/messages.json`
