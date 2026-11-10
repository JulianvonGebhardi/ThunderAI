/*
 *  ThunderAI [https://micz.it/thunderbird-addon-thunderai/]
 *  Copyright (C) 2024 - 2026  Mic (m@micz.it)

 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.

 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.

 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

// Native client for the Mistral AI API (https://api.mistral.ai).
// Wire format verified against the official @mistralai/mistralai SDK (v3.5.0):
//  - POST /v1/chat/completions  body: model, messages, temperature, max_tokens, stream,
//    response_format {type: 'json_object'}, reasoning_effort, safe_prompt
//  - GET  /v1/models            response: { object, data: [ { id, name, capabilities: { completion_chat, reasoning, ... },
//                                           max_context_length, aliases, deprecation, ... } ] }
//  - Streaming deltas: choices[0].delta.content is either a string or an array of chunks:
//    { type: 'text', text } or { type: 'thinking', thinking: [ { type: 'text', text } ] }
//  - Agents built in Mistral Studio are called through the Conversations API (see below)
//    when an agent id is configured; otherwise the Chat Completions API is used.

export const MISTRAL_API_HOST = 'https://api.mistral.ai';
export const MISTRAL_REASONING_EFFORTS = ['', 'none', 'low', 'medium', 'high'];

const RETRY_STATUSES = [429, 500, 502, 503, 504];

export class Mistral {

  apiKey = '';
  model = '';
  temperature = '';
  max_tokens = 0;
  system_prompt = '';
  reasoning_effort = '';
  safe_prompt = false;
  stream = false;
  max_retries = 3;
  agent_id = '';
  agent_version = '';

  constructor({
    apiKey = '',
    model = '',
    temperature = '',
    max_tokens = 0,
    system_prompt = '',
    reasoning_effort = '',
    safe_prompt = false,
    stream = false,
    max_retries = 3,
    agent_id = '',
    agent_version = '',
  } = {}) {
    this.agent_id = String(agent_id || '').trim();
    this.agent_version = String(agent_version ?? '').trim();
    this.apiKey = (apiKey || '').trim();
    this.model = model;
    this.temperature = temperature;
    this.max_tokens = parseInt(max_tokens) || 0;
    this.system_prompt = system_prompt || '';
    this.reasoning_effort = MISTRAL_REASONING_EFFORTS.includes(reasoning_effort) ? reasoning_effort : '';
    this.safe_prompt = (safe_prompt === true || safe_prompt === 'true');
    this.stream = stream;
    this.max_retries = max_retries;
  }

  _headers() {
    return {
      "Content-Type": "application/json",
      "Accept": this.stream ? "text/event-stream" : "application/json",
      "Authorization": "Bearer " + this.apiKey,
    };
  }

  // Build the request body. Exported via a method so it can be unit tested.
  buildRequestBody(messages, { json_mode = false } = {}) {
    let final_messages = messages;
    if (this.system_prompt && this.system_prompt.trim() !== '' && !messages.some(m => m.role === 'system')) {
      final_messages = [{ role: 'system', content: this.system_prompt.trim() }, ...messages];
    }
    const body = {
      model: this.model,
      messages: final_messages,
      stream: this.stream,
    };
    const tempFloat = parseFloat(this.temperature);
    if (this.temperature !== '' && this.temperature !== null && !Number.isNaN(tempFloat)) {
      body.temperature = tempFloat;
    }
    if (this.max_tokens > 0) {
      body.max_tokens = this.max_tokens;
    }
    if (this.reasoning_effort !== '') {
      body.reasoning_effort = this.reasoning_effort;
    }
    if (this.safe_prompt) {
      body.safe_prompt = true;
    }
    if (json_mode) {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  // fetch() wrapper that retries on rate limits and transient server errors.
  // Honors the Retry-After header when present, otherwise uses exponential backoff.
  async _fetchWithRetry(url, options) {
    let attempt = 0;
    while (true) {
      const response = await fetch(url, options);
      if (response.ok || !RETRY_STATUSES.includes(response.status) || attempt >= this.max_retries) {
        return response;
      }
      attempt++;
      let wait_ms = Math.min(1000 * Math.pow(2, attempt), 16000);
      const retryAfter = parseFloat(response.headers.get('Retry-After'));
      if (!Number.isNaN(retryAfter) && retryAfter > 0) {
        wait_ms = Math.min(retryAfter * 1000, 60000);
      }
      console.warn("[ThunderAI] Mistral API returned " + response.status + ", retrying in " + wait_ms + "ms (attempt " + attempt + "/" + this.max_retries + ")");
      await new Promise(resolve => setTimeout(resolve, wait_ms));
    }
  }

  fetchModels = async () => {
    try {
      const response = await this._fetchWithRetry(MISTRAL_API_HOST + "/v1/models", {
        method: "GET",
        headers: this._headers(),
      });

      if (!response.ok) {
        const errorDetail = await response.text();
        console.error("[ThunderAI] Mistral API request failed: " + response.status + " " + response.statusText + ", Detail: " + errorDetail);
        return { ok: false, error: errorDetail };
      }

      const output_response = await response.json();
      return { ok: true, response: Mistral.filterChatModels(output_response.data || []) };
    } catch (error) {
      console.error("[ThunderAI] Mistral API request failed: " + error);
      return { is_exception: true, ok: false, error: "Mistral API request failed: " + error };
    }
  }

  // Keep only models usable for chat, drop deprecated ones, de-duplicate and sort.
  static filterChatModels(models) {
    const now = Date.now();
    const seen = new Set();
    const output = [];
    for (const model of models) {
      if (!model || !model.id) continue;
      const caps = model.capabilities || {};
      if (caps.completion_chat === false) continue;
      if (model.deprecation) {
        const dep = Date.parse(model.deprecation);
        if (!Number.isNaN(dep) && dep < now) continue;
      }
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      output.push({
        id: model.id,
        name: model.name || model.id,
        reasoning: caps.reasoning === true,
        max_context_length: model.max_context_length || 0,
        is_latest_alias: model.id.endsWith('-latest'),
      });
    }
    // "-latest" aliases first: they are the safest choice because they follow Mistral's model updates.
    output.sort((a, b) => (b.is_latest_alias - a.is_latest_alias) || a.id.localeCompare(b.id));
    return output;
  }

  // Extracts text and thinking from a delta/message "content" field, which can be
  // a plain string or an array of typed chunks.
  static parseContent(content) {
    let text = '';
    let thinking = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const chunk of content) {
        if (!chunk) continue;
        if (chunk.type === 'text' && typeof chunk.text === 'string') {
          text += chunk.text;
        } else if (chunk.type === 'thinking') {
          const parts = Array.isArray(chunk.thinking) ? chunk.thinking : [chunk.thinking];
          for (const part of parts) {
            if (typeof part === 'string') thinking += part;
            else if (part && typeof part.text === 'string') thinking += part.text;
          }
        }
      }
    }
    return { text, thinking };
  }

  // Normalizes Mistral error payloads (several shapes exist) into a readable string.
  static parseErrorMessage(errorJSON) {
    if (!errorJSON) return '';
    if (typeof errorJSON === 'string') return errorJSON;
    if (typeof errorJSON.message === 'string') return errorJSON.message;
    if (errorJSON.error && typeof errorJSON.error.message === 'string') return errorJSON.error.message;
    if (Array.isArray(errorJSON.detail)) {
      return errorJSON.detail.map(d => (d.loc ? d.loc.join('.') + ': ' : '') + (d.msg || JSON.stringify(d))).join('; ');
    }
    if (typeof errorJSON.detail === 'string') return errorJSON.detail;
    return JSON.stringify(errorJSON);
  }

  // ---------------------------------------------------------------------------
  // Agents (Mistral Studio) via the Conversations API.
  // Verified against the official SDK: GET /v1/agents (array of Agent), GET /v1/agents/{id}/aliases,
  // POST /v1/conversations { agent_id, agent_version, inputs, stream, store, completion_args }.
  // ---------------------------------------------------------------------------

  isAgentMode() {
    return this.agent_id !== '';
  }

  fetchAgents = async () => {
    try {
      const response = await this._fetchWithRetry(MISTRAL_API_HOST + "/v1/agents?page=0&page_size=100", {
        method: "GET",
        headers: this._headers(),
      });
      if (!response.ok) {
        const errorDetail = await response.text();
        console.error("[ThunderAI] Mistral agents request failed: " + response.status + ", Detail: " + errorDetail);
        return { ok: false, error: errorDetail };
      }
      const data = await response.json();
      const list = Array.isArray(data) ? data : (data.data || data.items || []);
      return { ok: true, response: list.filter(a => a && a.id).map(a => ({
        id: a.id,
        name: a.name || a.id,
        description: a.description || '',
        model: a.model || '',
        version: a.version,
        tools: (a.tools || []).map(t => t.type).filter(Boolean),
      })) };
    } catch (error) {
      console.error("[ThunderAI] Mistral agents request failed: " + error);
      return { is_exception: true, ok: false, error: "Mistral API request failed: " + error };
    }
  }

  fetchAgentAliases = async (agentId) => {
    try {
      const response = await this._fetchWithRetry(MISTRAL_API_HOST + "/v1/agents/" + encodeURIComponent(agentId) + "/aliases", {
        method: "GET",
        headers: this._headers(),
      });
      if (!response.ok) return { ok: false, error: await response.text() };
      const data = await response.json();
      return { ok: true, response: (Array.isArray(data) ? data : []).map(a => ({ alias: a.alias, version: a.version })) };
    } catch (error) {
      return { is_exception: true, ok: false, error: "Mistral API request failed: " + error };
    }
  }

  // Converts a chat history into Conversations API input entries. The full history is sent with
  // store=false, so Mistral does not keep the conversation (privacy) and no conversation id is needed.
  static messagesToEntries(messages) {
    return messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => m.role === 'user'
        ? { type: 'message.input', role: 'user', content: m.content }
        : { type: 'message.output', role: 'assistant', content: m.content });
  }

  buildConversationBody(messages, { json_mode = false } = {}) {
    const body = {
      agent_id: this.agent_id,
      inputs: Mistral.messagesToEntries(messages),
      stream: this.stream,
      store: false,
    };
    const version = String(this.agent_version || '').trim();
    if (version !== '') {
      body.agent_version = /^\d+$/.test(version) ? parseInt(version) : version;
    }
    // The agent's own completion settings (model, temperature, instructions) are kept;
    // only the output format is requested when the caller needs JSON.
    if (json_mode) {
      body.completion_args = { response_format: { type: 'json_object' } };
    }
    return body;
  }

  // Parses one Conversations API stream event (or a non streamed output entry).
  // Returns { text, thinking, tool, sources, error, done, conversation_id }.
  static parseConversationEvent(data) {
    const out = { text: '', thinking: '', tool: '', sources: [], error: '', done: false, conversation_id: '' };
    if (!data || typeof data !== 'object') return out;
    switch (data.type) {
      case 'conversation.response.started':
        out.conversation_id = data.conversation_id || '';
        break;
      case 'message.output.delta':
      case 'message.output': {
        const content = data.content;
        const parsed = Mistral.parseContent(typeof content === 'string' ? content : (Array.isArray(content) ? content : [content]));
        out.text = parsed.text;
        out.thinking = parsed.thinking;
        const chunks = Array.isArray(content) ? content : [content];
        for (const c of chunks) {
          if (c && c.type === 'tool_reference' && c.title) out.sources.push({ title: c.title, url: c.url || '' });
        }
        break;
      }
      case 'tool.execution.started':
        out.tool = data.name || 'tool';
        break;
      case 'conversation.response.error':
        out.error = (data.message || 'Error') + (data.code ? ' (' + data.code + ')' : '');
        break;
      case 'conversation.response.done':
        out.done = true;
        break;
    }
    return out;
  }

  fetchResponse = async (messages, options = {}) => {
    try {
      const agentMode = this.isAgentMode();
      const body = agentMode ? this.buildConversationBody(messages, options) : this.buildRequestBody(messages, options);
      return await this._fetchWithRetry(MISTRAL_API_HOST + (agentMode ? "/v1/conversations" : "/v1/chat/completions"), {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (error) {
      console.error("[ThunderAI] Mistral API request failed: " + error);
      return { is_exception: true, ok: false, error: "Mistral API request failed: " + error };
    }
  }

}
