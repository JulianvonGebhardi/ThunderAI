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
 *
 *
 *  This file contains a modified version of the code from the project at https://github.com/boxabirds/chatgpt-frontend-nobuild
 *  The original code has been released under the Apache License, Version 2.0.
 */

import { Mistral } from '../api/mistral.js';
import { taLogger } from '../mzta-logger.js';

let mistral = null;
let stopStreaming = false;
let i18nStrings = null;
let do_debug = false;
let taLog = null;

let conversationHistory = [];
let assistantResponseAccumulator = '';
let thinkingAccumulator = '';
let sourcesAccumulator = [];
let streamError = '';

function finishResponse(stopped = false) {
    // Sources found by agent tools (web search, document library) are shown with the
    // reasoning block, so they never end up in the text inserted into an email.
    if (sourcesAccumulator.length > 0) {
        const lines = sourcesAccumulator.map(s => '- ' + s.title + (s.url ? ' (' + s.url + ')' : ''));
        const sourcesText = '\n\n' + ((i18nStrings && i18nStrings["mistral_sources"]) || 'Sources') + ':\n' + lines.join('\n');
        thinkingAccumulator += sourcesText;
        postMessage({ type: 'newThinkingToken', payload: { token: sourcesText } });
        sourcesAccumulator = [];
    }
    taLog.log("AI full response" + (stopped ? " [STOPPED]" : "") + ": " + assistantResponseAccumulator);
    conversationHistory.push({ role: 'assistant', content: assistantResponseAccumulator });
    assistantResponseAccumulator = '';
    postMessage({ type: 'tokensDone', payload: { thinking: thinkingAccumulator } });
    thinkingAccumulator = '';
}

// Parses one SSE "data:" payload line. Returns null for keep-alives and the [DONE] marker.
function parseSSELine(line) {
    const clean = line.trim();
    if (clean === '' || clean.startsWith(':') || clean.startsWith('event:')) return null;
    if (!clean.startsWith('data:')) return null;
    const payload = clean.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return null;
    try {
        return JSON.parse(payload);
    } catch (e) {
        taLog.warn("JSON parse warning, skipped line: " + payload + " - " + e.message);
        return null;
    }
}

self.onmessage = async function(event) {
    if (event.data.type === 'init') {
        let config = { stream: true };
        for (const key in event.data) {
            if (key.startsWith('mistral_')) {
                let newKey = key.replace('mistral_', '');
                if (newKey === 'api_key') newKey = 'apiKey';
                config[newKey] = event.data[key];
            }
        }
        mistral = new Mistral(config);
        // A new configuration starts a new conversation.
        conversationHistory = [];
        assistantResponseAccumulator = '';
        thinkingAccumulator = '';
        sourcesAccumulator = [];
        do_debug = event.data.do_debug;
        i18nStrings = event.data.i18nStrings || {};
        taLog = new taLogger('model-worker-mistral', do_debug);
    } else if (event.data.type === 'chatMessage') {
        conversationHistory.push({ role: 'user', content: event.data.message });

        const response = await mistral.fetchResponse(conversationHistory, { json_mode: event.data.json_mode === true });
        postMessage({ type: 'messageSent' });

        const failedLabel = (i18nStrings && i18nStrings["mistral_api_request_failed"]) || "Mistral API request failed";

        if (!response.ok) {
            let error_message = '';
            let errorDetail = '';
            if (response.is_exception === true) {
                error_message = response.error;
            } else {
                try {
                    const errorJSON = await response.json();
                    errorDetail = JSON.stringify(errorJSON);
                    error_message = Mistral.parseErrorMessage(errorJSON);
                } catch (e) {
                    error_message = response.statusText;
                }
                taLog.log("error_message: " + JSON.stringify(error_message));
            }
            // Remove the failed user message so a retry in the same chat starts clean.
            conversationHistory.pop();
            const status = response.status ? response.status + " " + response.statusText : '';
            postMessage({ type: 'error', payload: failedLabel + ": " + status + ", Detail: " + error_message + " " + errorDetail });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = '';

        try {
            while (true) {
                if (stopStreaming) {
                    stopStreaming = false;
                    reader.cancel();
                    finishResponse(true);
                    break;
                }
                const { done, value } = await reader.read();
                if (done) {
                    // Flush a last line without trailing newline, if any.
                    const last = parseSSELine(buffer);
                    if (last) handleChunk(last);
                    if (streamError) {
                        reportStreamError(failedLabel);
                    } else {
                        finishResponse(false);
                    }
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                    const parsed = parseSSELine(line);
                    if (parsed) handleChunk(parsed);
                }
            }
        } catch (e) {
            taLog.error("Stream reading error: " + e);
            const interrupted = (i18nStrings && i18nStrings["error_connection_interrupted"]) || "Connection interrupted";
            assistantResponseAccumulator = '';
            thinkingAccumulator = '';
            sourcesAccumulator = [];
            conversationHistory.pop();
            postMessage({ type: 'error', payload: failedLabel + ": " + interrupted + " (" + e.message + ")" });
        }
    } else if (event.data.type === 'stop') {
        stopStreaming = true;
    }
};

function reportStreamError(failedLabel) {
    conversationHistory.pop();
    assistantResponseAccumulator = '';
    thinkingAccumulator = '';
    sourcesAccumulator = [];
    const message = streamError;
    streamError = '';
    postMessage({ type: 'error', payload: failedLabel + ": " + message });
}

// Conversations API (Mistral Studio agents) stream events.
function handleConversationEvent(event) {
    const parsed = Mistral.parseConversationEvent(event);
    if (parsed.error) {
        streamError = parsed.error;
        return;
    }
    if (parsed.tool) {
        const label = ((i18nStrings && i18nStrings["mistral_agent_tool"]) || 'Using tool') + ': ' + parsed.tool + '\n';
        thinkingAccumulator += label;
        postMessage({ type: 'newThinkingToken', payload: { token: label } });
    }
    if (parsed.thinking) {
        thinkingAccumulator += parsed.thinking;
        postMessage({ type: 'newThinkingToken', payload: { token: parsed.thinking } });
    }
    for (const src of parsed.sources) {
        if (!sourcesAccumulator.some(s => s.title === src.title && s.url === src.url)) sourcesAccumulator.push(src);
    }
    if (parsed.text) {
        assistantResponseAccumulator += parsed.text;
        postMessage({ type: 'newToken', payload: { token: parsed.text } });
    }
}

function handleChunk(parsedLine) {
    if (mistral.isAgentMode() && typeof parsedLine.type === 'string') {
        handleConversationEvent(parsedLine);
        return;
    }
    if (parsedLine.object === 'error' || (parsedLine.message && !parsedLine.choices)) {
        taLog.error("Error chunk received: " + JSON.stringify(parsedLine));
        return;
    }
    const { choices } = parsedLine;
    if (!choices || choices.length === 0) {
        return;
    }
    const delta = choices[0].delta || {};
    const { text, thinking } = Mistral.parseContent(delta.content);
    if (thinking) {
        thinkingAccumulator += thinking;
        postMessage({ type: 'newThinkingToken', payload: { token: thinking } });
    }
    if (text) {
        assistantResponseAccumulator += text;
        postMessage({ type: 'newToken', payload: { token: text } });
    }
}
