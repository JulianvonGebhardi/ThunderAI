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

// Inbox Assistant dashboard. See claude-spec/07-inbox-assistant.md

import { prefs_default } from '../../options/mzta-options-default.js';
import { taLogger } from '../../js/mzta-logger.js';
import { createTag } from '../../js/mzta-utils.js';
import {
    getAccountsWithIdentities,
    listAllFolders,
    loadCategories,
    getCategoryDisplayName,
    collectMessages,
    triageMessages,
    getInboxAIConfig,
    getInboxPrefs,
    runAIPrompt,
    buildBriefPrompt,
    buildReplyPrompt,
    computeSenderStats,
    getUnsubscribeInfo,
    oneClickUnsubscribe,
    parseMailto,
    setSenderRule,
    saveTriageResults,
    findUnansweredSent,
    classifyFollowups,
    runWithConcurrency,
    isAbortError,
} from '../../js/mzta-inbox-engine.js';
import {
    executePlan,
    opsFromCategory,
    opsIsEmpty,
    permissionsForOps,
    requestPermissionsForOps,
    isMessageProtected,
    loadActivity,
    undoActivity,
    clearActivity,
} from '../../js/mzta-inbox-actions.js';

const PROVIDER_LABELS = {
    chatgpt_api: 'OpenAI',
    google_gemini_api: 'Google Gemini',
    anthropic_api: 'Claude',
    mistral_api: 'Mistral AI',
    ollama_api: 'Ollama',
    openai_comp_api: 'OpenAI Compatible',
};

const state = {
    log: null,
    accounts: [],
    folders: [],
    categories: [],
    tags: [],
    entries: new Map(),      // messageId -> { message, digest, result }
    selected: new Set(),
    filterCat: null,
    collapsed: new Set(),
    abort: null,
    aiConfig: null,
    senders: [],
    sendersSelected: new Set(),
    sendersMessages: [],
    sendersFilter: null,     // null or Set of emails (quick win filter)
    unsubInfo: new Map(),    // email -> info
    waiting: [],
    busy: false,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

function t(key, subs) {
    const msg = browser.i18n.getMessage(key, subs);
    return msg || key;
}

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (typeof v === 'boolean' || k === 'value') el[k] = v;
        else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

function formatDate(d) {
    if (!d) return '';
    const date = new Date(d);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    const opts = { day: 'numeric', month: 'short' };
    if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return date.toLocaleDateString(undefined, opts);
}

function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function textToHtml(text) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return String(text || '').trim().split(/\n{2,}/).map(p => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}

let toastTimer = null;
function toast(message, { error = false, undoEntryId = null, duration = 7000 } = {}) {
    const el = $('ia_toast');
    $('ia_toast_text').textContent = message;
    el.classList.toggle('error', error);
    const undoBtn = $('ia_toast_undo');
    undoBtn.classList.toggle('hidden', !undoEntryId);
    undoBtn.onclick = undoEntryId ? async () => {
        el.classList.add('hidden');
        await doUndo(undoEntryId);
    } : null;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

function setProgress(prefix, info) {
    const box = $(prefix);
    const bar = $(prefix + '_bar');
    const text = $(prefix + '_text');
    if (!info) {
        box.classList.add('hidden');
        return;
    }
    box.classList.remove('hidden');
    let pct = 0;
    let label = '';
    switch (info.phase) {
        case 'collect':
            pct = 5;
            label = t('inbox_progress_collect', [String(info.count)]);
            break;
        case 'read':
            pct = 5 + Math.round(25 * info.done / Math.max(1, info.total));
            label = t('inbox_progress_read', [String(info.done), String(info.total)]);
            break;
        case 'analyze':
            pct = 30 + Math.round(70 * info.done / Math.max(1, info.total));
            label = t('inbox_progress_analyze', [String(info.done), String(info.total)]);
            break;
        case 'apply':
            pct = Math.round(100 * info.done / Math.max(1, info.total));
            label = t('inbox_progress_apply', [String(info.done), String(info.total)]);
            break;
        case 'followups':
            pct = Math.round(100 * info.done / Math.max(1, info.total));
            label = t('inbox_progress_followups', [String(info.done), String(info.total)]);
            break;
        default:
            pct = info.pct || 0;
            label = info.label || '';
    }
    bar.style.width = Math.min(100, pct) + '%';
    text.textContent = label;
}

function categoryById(id) {
    return state.categories.find(c => c.id === id) || state.categories.find(c => c.id === 'other');
}

function describeOps(ops) {
    const parts = [];
    if (ops.mark_read) parts.push(t('inbox_act_read'));
    if (ops.mark_unread) parts.push(t('inbox_act_unread'));
    if (ops.flag) parts.push(t('inbox_act_flag'));
    if (ops.unflag) parts.push(t('inbox_act_unflag'));
    if (ops.tag_key) {
        const tag = state.tags.find(x => x.key === ops.tag_key);
        parts.push(t('inbox_act_tag') + ': ' + (tag ? tag.tag : ops.tag_key));
    }
    switch (ops.move) {
        case 'archive': parts.push(t('inbox_act_archive')); break;
        case 'trash': parts.push(t('inbox_act_trash')); break;
        case 'junk': parts.push(t('inbox_act_junk')); break;
        case 'folder': {
            const f = state.folders.find(x => x.id === ops.folder_id);
            parts.push(t('inbox_act_move') + ': ' + (f ? f.accountName + ' / ' + f.name : (ops.folder_name || '?')));
            break;
        }
    }
    return parts.length > 0 ? parts.join(' · ') : t('inbox_suggest_keep');
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function getScope() {
    const accountIds = [...document.querySelectorAll('#ia_accounts input:checked')].map(i => i.value);
    const folderMode = $('ia_folder_mode').value;
    const folderIds = [...$('ia_custom_folders').selectedOptions].map(o => o.value);
    return {
        accountIds: accountIds.length === state.accounts.length ? [] : accountIds,
        folderMode,
        folderIds,
        days: parseInt($('ia_days').value) || 0,
        maxMessages: Math.min(3000, Math.max(10, parseInt($('ia_max').value) || 200)),
        unreadOnly: $('ia_unread_only').checked,
    };
}

async function saveScope() {
    const s = getScope();
    await browser.storage.sync.set({
        inbox_scan_accounts: s.accountIds,
        inbox_scan_folder_mode: s.folderMode === 'custom' ? 'inbox' : s.folderMode,
        inbox_scan_days: s.days,
        inbox_scan_max: s.maxMessages,
        inbox_scan_unread_only: s.unreadOnly,
    });
}

function renderScope(prefs) {
    const box = $('ia_accounts');
    box.textContent = '';
    for (const a of state.accounts) {
        const checked = prefs.inbox_scan_accounts.length === 0 || prefs.inbox_scan_accounts.includes(a.id);
        const input = h('input', { type: 'checkbox', value: a.id, checked });
        const chip = h('label', { class: 'ia-chip' + (checked ? ' active' : '') }, input, a.name);
        input.addEventListener('change', () => {
            if (document.querySelectorAll('#ia_accounts input:checked').length === 0) input.checked = true;
            chip.classList.toggle('active', input.checked);
            renderCustomFolders();
            saveScope();
        });
        box.append(chip);
    }
    $('ia_folder_mode').value = prefs.inbox_scan_folder_mode;
    $('ia_days').value = String(prefs.inbox_scan_days);
    if (!$('ia_days').value) $('ia_days').value = '30';
    $('ia_max').value = prefs.inbox_scan_max;
    $('ia_unread_only').checked = prefs.inbox_scan_unread_only;
    renderCustomFolders();
    updateFolderModeUI();
}

function renderCustomFolders(preselect = null) {
    const sel = $('ia_custom_folders');
    const previous = preselect || [...sel.selectedOptions].map(o => o.value);
    const accountIds = [...document.querySelectorAll('#ia_accounts input:checked')].map(i => i.value);
    sel.textContent = '';
    for (const f of state.folders) {
        if (accountIds.length > 0 && !accountIds.includes(f.accountId) && !(preselect && preselect.includes(f.id))) continue;
        const label = f.accountName + ' / ' + '  '.repeat(f.depth) + f.name;
        sel.append(h('option', { value: f.id, selected: previous.includes(f.id) }, label));
    }
}

function updateFolderModeUI() {
    $('ia_custom_folders_field').classList.toggle('hidden', $('ia_folder_mode').value !== 'custom');
}

// ---------------------------------------------------------------------------
// AI provider info
// ---------------------------------------------------------------------------

async function refreshProvider() {
    state.aiConfig = await getInboxAIConfig();
    const badge = $('ia_provider');
    badge.textContent = '';
    if (!state.aiConfig.usable) {
        badge.append(t('inbox_provider_none'));
        $('ia_api_warning').classList.remove('hidden');
        return;
    }
    $('ia_api_warning').classList.add('hidden');
    const integration = state.aiConfig.llm.replace('_api', '');
    const modelKey = integration + '_model';
    const agentKey = integration + '_agent_id';
    const prefs = await browser.storage.sync.get({ [modelKey]: prefs_default[modelKey] || '', [agentKey]: '' });
    const prompt = state.aiConfig.prompt || {};
    const fromPrompt = prompt.api_type === state.aiConfig.llm;
    const agent = fromPrompt && prompt[agentKey] !== undefined ? prompt[agentKey] : prefs[agentKey];
    const model = (fromPrompt && prompt[modelKey]) ? prompt[modelKey] : prefs[modelKey];
    const detail = agent ? t('inbox_provider_agent', [agent]) : model;
    badge.append(t('inbox_provider_label') + ' ', h('b', {}, PROVIDER_LABELS[state.aiConfig.llm] || state.aiConfig.llm), detail ? ' · ' + detail : '');
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

function setBusy(busy) {
    state.busy = busy;
    $('btn_scan').disabled = busy;
    $('btn_scan_senders').disabled = busy;
    $('btn_scan_followups').disabled = busy;
    $('btn_stop').classList.toggle('hidden', !busy);
    updateTriageButtons();
}

function updateTriageButtons() {
    const has = state.entries.size > 0;
    $('btn_brief').disabled = state.busy || !has || !state.aiConfig?.usable;
    $('btn_apply_suggested').disabled = state.busy || !has;
}

async function startScan(messagesOverride = null) {
    if (state.busy) return;
    if (!state.aiConfig || !state.aiConfig.usable) {
        $('ia_api_warning').classList.remove('hidden');
        toast(t('inbox_error_needs_api'), { error: true });
        return;
    }
    state.abort = new AbortController();
    setBusy(true);
    switchTab('triage');
    const signal = state.abort.signal;
    try {
        let messages = messagesOverride;
        if (!messages) {
            await saveScope();
            setProgress('ia_progress', { phase: 'collect', count: 0 });
            messages = await collectMessages(getScope(), { signal, onProgress: p => setProgress('ia_progress', p) });
        }
        if (messages.length === 0) {
            toast(t('inbox_no_messages'));
            return;
        }
        const results = await triageMessages(messages, {
            useCache: $('ia_use_cache').checked,
            signal,
            categories: state.categories,
            onProgress: p => setProgress('ia_progress', p),
        });
        state.entries = new Map();
        state.selected.clear();
        state.filterCat = null;
        for (const m of messages) {
            const r = results.get(m.id);
            if (r) state.entries.set(m.id, { message: m, digest: r.digest, result: r.result });
        }
        renderResults();
        renderNeedsReply();
        const failed = [...state.entries.values()].filter(e => e.result.source === 'fallback');
        if (signal.aborted) {
            toast(t('inbox_scan_stopped', [String(state.entries.size)]));
        } else if (failed.length > 0) {
            const firstError = failed.find(f => f.result.error)?.result.error || '';
            toast(t('inbox_scan_partial', [String(failed.length)]) + (firstError ? ' (' + firstError.slice(0, 160) + ')' : ''), { error: true, duration: 12000 });
        } else {
            toast(t('inbox_scan_done', [String(state.entries.size)]));
        }
    } catch (e) {
        if (isAbortError(e)) {
            toast(t('inbox_scan_stopped', [String(state.entries.size)]));
        } else {
            console.error('[ThunderAI | Inbox] Scan failed', e);
            if (e.isConfigError) $('ia_api_warning').classList.remove('hidden');
            toast(t('inbox_error_generic') + ': ' + e.message, { error: true, duration: 12000 });
        }
    } finally {
        setProgress('ia_progress', null);
        setBusy(false);
        state.abort = null;
    }
}

function visibleEntries() {
    return [...state.entries.values()].filter(e => !state.filterCat || e.result.category === state.filterCat);
}

function renderResults() {
    const container = $('ia_results');
    container.textContent = '';
    $('ia_empty').classList.toggle('hidden', state.entries.size > 0);
    renderCategorySummary();
    renderBulkBar();
    updateTriageButtons();
    if (state.entries.size === 0) return;

    const byCat = new Map();
    for (const e of visibleEntries()) {
        const id = categoryById(e.result.category).id;
        if (!byCat.has(id)) byCat.set(id, []);
        byCat.get(id).push(e);
    }
    for (const cat of state.categories) {
        const list = byCat.get(cat.id);
        if (!list || list.length === 0) continue;
        list.sort((a, b) => (a.result.priority - b.result.priority) || (new Date(b.message.date) - new Date(a.message.date)));
        container.append(renderGroup(cat, list));
    }
}

function renderCategorySummary() {
    const box = $('ia_cat_summary');
    box.textContent = '';
    if (state.entries.size === 0) return;
    const counts = {};
    for (const e of state.entries.values()) counts[e.result.category] = (counts[e.result.category] || 0) + 1;
    box.append(h('span', { class: 'ia-cat-pill' + (state.filterCat ? '' : ' active'), onclick: () => { state.filterCat = null; renderResults(); } },
        t('inbox_all'), h('span', { class: 'ia-count' }, state.entries.size)));
    for (const cat of state.categories) {
        if (!counts[cat.id]) continue;
        box.append(h('span', {
            class: 'ia-cat-pill' + (state.filterCat === cat.id ? ' active' : ''),
            style: { '--cat-color': cat.color },
            onclick: () => { state.filterCat = state.filterCat === cat.id ? null : cat.id; renderResults(); },
        }, h('span', { class: 'ia-dot' }), getCategoryDisplayName(cat), h('span', { class: 'ia-count' }, counts[cat.id])));
    }
}

function renderGroup(cat, list) {
    const ops = opsFromCategory(cat);
    const groupCheck = h('input', { type: 'checkbox', title: t('inbox_select_group'), checked: list.every(e => state.selected.has(e.message.id)) });
    groupCheck.addEventListener('change', () => {
        for (const e of list) groupCheck.checked ? state.selected.add(e.message.id) : state.selected.delete(e.message.id);
        renderResults();
    });
    const group = h('div', { class: 'ia-group' + (state.collapsed.has(cat.id) ? ' collapsed' : ''), style: { '--cat-color': cat.color }, dataset: { cat: cat.id } });
    const head = h('div', { class: 'ia-group-head' },
        groupCheck,
        h('span', { class: 'ia-dot' }),
        h('h3', {}, getCategoryDisplayName(cat)),
        h('span', { class: 'ia-count' }, list.length),
        h('span', { class: 'ia-suggest' }, t('inbox_suggested') + ': ' + describeOps(ops)),
        h('span', { class: 'spacer' }),
        opsIsEmpty(ops) ? null : h('button', { class: 'ia-btn small accent', onclick: () => applyCategory(cat, list) }, t('inbox_apply_to', [String(list.length)])),
        h('button', {
            class: 'ia-btn small ghost', title: t('inbox_collapse'),
            onclick: () => { state.collapsed.has(cat.id) ? state.collapsed.delete(cat.id) : state.collapsed.add(cat.id); group.classList.toggle('collapsed'); },
        }, '▾'),
    );
    const tbody = h('tbody');
    for (const e of list) tbody.append(renderRow(e));
    group.append(head, h('table', { class: 'ia-table' }, tbody));
    return group;
}

function renderRow(entry) {
    const m = entry.message;
    const d = entry.digest;
    const r = entry.result;
    const check = h('input', { type: 'checkbox', checked: state.selected.has(m.id) });
    check.addEventListener('change', () => {
        check.checked ? state.selected.add(m.id) : state.selected.delete(m.id);
        renderBulkBar();
    });
    const catSelect = h('select', { title: t('inbox_change_category') });
    for (const c of state.categories.filter(c => c.enabled)) {
        catSelect.append(h('option', { value: c.id, selected: c.id === r.category }, getCategoryDisplayName(c)));
    }
    catSelect.addEventListener('change', () => changeCategory(entry, catSelect.value));

    const badges = [];
    if (r.due) badges.push(h('span', { class: 'ia-badge due', title: t('inbox_due') }, '\u{1F4C5} ' + r.due));
    if (r.needs_reply) badges.push(h('span', { class: 'ia-badge reply' }, t('inbox_badge_reply')));
    if (d.isList) badges.push(h('span', { class: 'ia-badge list' }, t('inbox_badge_list')));
    if (r.source === 'rule') badges.push(h('span', { class: 'ia-badge', title: t('inbox_badge_rule_info') }, '\u{1F4CC} ' + t('inbox_badge_rule')));
    if (r.source === 'fallback') badges.push(h('span', { class: 'ia-badge', title: r.error || '' }, '⚠ ' + t('inbox_badge_unclassified')));

    return h('tr', { class: m.read === false ? 'ia-unread' : '', dataset: { id: String(m.id) } },
        h('td', { class: 'ia-c-check' }, check),
        h('td', { class: 'ia-c-prio' }, h('span', { class: 'ia-p' + r.priority, title: t('inbox_priority_' + r.priority) })),
        h('td', { class: 'ia-c-from', title: d.fromEmail }, h('b', {}, d.fromName || d.fromEmail), h('small', {}, d.fromEmail)),
        h('td', { class: 'ia-c-subj' },
            h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openMessage(m.id); } }, m.subject || t('inbox_no_subject')),
            ...badges,
            r.summary ? h('div', { class: 'ia-summary' }, r.summary) : null),
        h('td', { class: 'ia-c-date' }, formatDate(m.date)),
        h('td', { class: 'ia-c-tools' },
            catSelect,
            h('button', { class: 'ia-btn icon small ghost', title: t('inbox_pin_sender', [d.fromEmail]), onclick: () => pinSender(entry) }, '\u{1F4CC}'),
            h('button', { class: 'ia-btn icon small ghost', title: t('inbox_draft_reply'), onclick: () => openReplyDialog(m) }, '↩'),
        ),
    );
}

async function changeCategory(entry, categoryId) {
    entry.result = { ...entry.result, category: categoryId, source: 'user', needs_reply: categoryId === 'reply' ? true : entry.result.needs_reply };
    await saveTriageResults({ [entry.message.headerMessageId]: entry.result });
    renderResults();
    renderNeedsReply();
}

async function pinSender(entry) {
    const email = entry.digest.fromEmail;
    if (!email) return;
    const cat = categoryById(entry.result.category);
    await setSenderRule(email, cat.id);
    let changed = 0;
    for (const e of state.entries.values()) {
        if (e.digest.fromEmail === email && e.result.category !== cat.id) {
            e.result = { ...e.result, category: cat.id, source: 'rule' };
            changed++;
        }
    }
    renderResults();
    toast(t('inbox_pinned', [email, getCategoryDisplayName(cat)]) + (changed ? ' (+' + changed + ')' : ''));
}

function renderBulkBar() {
    // Drop selections of messages that are no longer listed.
    for (const id of [...state.selected]) if (!state.entries.has(id)) state.selected.delete(id);
    const n = state.selected.size;
    $('ia_bulkbar').classList.toggle('hidden', n === 0);
    $('ia_sel_count').textContent = t('inbox_selected', [String(n)]);
    const sel = $('ia_bulk_category');
    sel.textContent = '';
    sel.append(h('option', { value: '' }, t('inbox_set_category')));
    for (const c of state.categories.filter(c => c.enabled)) sel.append(h('option', { value: c.id }, getCategoryDisplayName(c)));
}

// After a plan ran: drop moved messages from the lists and refresh the others.
async function afterPlan(plan, res, label) {
    for (const item of plan) {
        if (item.failed || !item.record) continue;
        if (item.record.moved) {
            state.entries.delete(item.message.id);
            state.selected.delete(item.message.id);
        } else {
            try {
                const fresh = await browser.messages.get(item.message.id);
                const e = state.entries.get(item.message.id);
                if (e) e.message = fresh;
            } catch (e) {
                state.entries.delete(item.message.id);
            }
        }
    }
    renderResults();
    renderNeedsReply();
    renderActivity();
    if (res.failed > 0) {
        toast(t('inbox_apply_result_failed', [String(res.done), String(res.failed)]) + (res.errors[0] ? ': ' + res.errors[0] : ''), { error: true, undoEntryId: res.entryId, duration: 12000 });
    } else {
        toast(t('inbox_apply_result', [String(res.done)]) + (label ? ' · ' + label : ''), { undoEntryId: res.entryId });
    }
}

async function runPlanCore(plan, label, source = 'manual') {
    if (plan.length === 0) return;
    setBusy(true);
    try {
        const res = await executePlan(plan, { source, label, onProgress: p => setProgress('ia_progress', { phase: 'apply', ...p }) });
        await afterPlan(plan, res, label);
    } catch (e) {
        console.error('[ThunderAI | Inbox] Apply failed', e);
        toast(t('inbox_error_generic') + ': ' + e.message, { error: true });
    } finally {
        setProgress('ia_progress', null);
        setBusy(false);
    }
}

// Builds a plan for suggested actions, skipping protected messages.
async function buildSuggestedPlan(entries, ops) {
    const prefs = await getInboxPrefs();
    const plan = [];
    const skipped = [];
    for (const e of entries) {
        const prot = ops.move === 'none' && !ops.mark_read ? false : await isMessageProtected(e.message, {
            protectedSenders: prefs.inbox_protected_senders,
            protectContacts: prefs.inbox_protect_contacts,
            skipFlagged: prefs.inbox_skip_flagged && !ops.flag,
        });
        if (prot) skipped.push(e);
        else plan.push({ message: e.message, ops: { ...ops } });
    }
    return { plan, skipped };
}

// Shows the confirmation dialog. rows: [{ id, label, detail, count, checked }]
// getOps(checkedIds) returns the ops whose permissions must be requested on confirm.
function confirmDialog({ title, intro, rows, note = null, getOps }) {
    return new Promise(resolve => {
        const dlg = $('dlg_plan');
        $('dlg_plan_title').textContent = title;
        $('dlg_plan_intro').textContent = intro || '';
        $('dlg_plan_note').textContent = note || t('inbox_confirm_note');
        const list = $('dlg_plan_list');
        list.textContent = '';
        for (const r of rows) {
            list.append(h('li', {},
                h('input', { type: 'checkbox', value: r.id, checked: r.checked !== false }),
                h('div', {}, h('b', {}, r.label), h('div', { class: 'ia-muted' }, r.detail)),
                h('span', { class: 'ia-muted' }, r.count)));
        }
        let settled = false;
        const ok = $('dlg_plan_ok');
        const onOk = (ev) => {
            ev.preventDefault();
            const checked = [...list.querySelectorAll('input:checked')].map(i => i.value);
            // Permissions must be requested synchronously inside the click handler.
            const perm = requestPermissionsForOps(getOps(checked));
            settled = true;
            cleanup();
            dlg.close();
            perm.then(granted => resolve({ ok: granted, denied: !granted, checked }))
                .catch(e => { console.error(e); resolve({ ok: false, denied: true, checked }); });
        };
        const onClose = () => {
            cleanup();
            if (!settled) resolve({ ok: false, checked: [] });
        };
        const cleanup = () => {
            ok.removeEventListener('click', onOk);
            dlg.removeEventListener('close', onClose);
        };
        ok.addEventListener('click', onOk);
        dlg.addEventListener('close', onClose);
        dlg.showModal();
    });
}

async function applyCategory(cat, list) {
    const ops = opsFromCategory(cat);
    const { plan, skipped } = await buildSuggestedPlan(list, ops);
    const rows = [{ id: cat.id, label: getCategoryDisplayName(cat), detail: describeOps(ops), count: plan.length }];
    const answer = await confirmDialog({
        title: t('inbox_confirm_title'),
        intro: skipped.length > 0 ? t('inbox_confirm_skipped', [String(skipped.length)]) : '',
        rows,
        getOps: () => [ops],
    });
    if (answer.denied) toast(t('inbox_permission_denied'), { error: true });
    if (!answer.ok || !answer.checked.includes(cat.id)) return;
    await runPlan(plan, getCategoryDisplayName(cat) + ': ' + describeOps(ops));
}

async function applyAllSuggested() {
    const groups = [];
    for (const cat of state.categories) {
        const ops = opsFromCategory(cat);
        if (opsIsEmpty(ops)) continue;
        const list = [...state.entries.values()].filter(e => e.result.category === cat.id);
        if (list.length === 0) continue;
        const { plan, skipped } = await buildSuggestedPlan(list, ops);
        if (plan.length === 0) continue;
        groups.push({ cat, ops, plan, skipped });
    }
    if (groups.length === 0) {
        toast(t('inbox_nothing_to_apply'));
        return;
    }
    const totalSkipped = groups.reduce((n, g) => n + g.skipped.length, 0);
    const answer = await confirmDialog({
        title: t('inbox_confirm_all_title'),
        intro: t('inbox_confirm_all_intro') + (totalSkipped > 0 ? ' ' + t('inbox_confirm_skipped', [String(totalSkipped)]) : ''),
        rows: groups.map(g => ({ id: g.cat.id, label: getCategoryDisplayName(g.cat), detail: describeOps(g.ops), count: g.plan.length, checked: g.ops.move !== 'trash' })),
        getOps: (checked) => groups.filter(g => checked.includes(g.cat.id)).map(g => g.ops),
    });
    if (answer.denied) toast(t('inbox_permission_denied'), { error: true });
    if (!answer.ok) return;
    const chosen = groups.filter(g => answer.checked.includes(g.cat.id));
    const plan = chosen.flatMap(g => g.plan);
    await runPlan(plan, chosen.map(g => getCategoryDisplayName(g.cat) + ' ' + g.plan.length).join(', '));
}

// ---------------------------------------------------------------------------
// Bulk actions on the selection (triage and senders tabs)
// ---------------------------------------------------------------------------

const BULK_OPS = {
    read: { mark_read: true },
    unread: { mark_unread: true },
    flag: { flag: true },
    archive: { move: 'archive' },
    trash: { move: 'trash' },
    junk: { move: 'junk', mark_read: true },
};

// Must be called directly from a click handler.
function bulkAction(action, messages, label) {
    if (messages.length === 0) return;
    if (action === 'folder') return pickFolder(messages, label);
    if (action === 'tag') return pickTag(messages, label);
    const ops = BULK_OPS[action];
    if (!ops) return;
    if ((action === 'trash' || action === 'junk') && !confirm(t('inbox_confirm_destructive', [String(messages.length), describeOps(ops)]))) return;
    const perm = requestPermissionsForOps([ops]);
    perm.then(granted => {
        if (!granted) {
            toast(t('inbox_permission_denied'), { error: true });
            return;
        }
        runPlan(messages.map(m => ({ message: m, ops: { ...ops } })), label || describeOps(ops));
    });
}

function bulkLabel(action, count) {
    return BULK_OPS[action] ? describeOps(BULK_OPS[action]) + ' (' + count + ')' : null;
}

function selectedMessages() {
    return [...state.selected].map(id => state.entries.get(id)).filter(Boolean).map(e => e.message);
}

function pickFolder(messages, label) {
    const dlg = $('dlg_folder');
    const sel = $('dlg_folder_select');
    sel.textContent = '';
    for (const f of state.folders) {
        sel.append(h('option', { value: f.id }, f.accountName + ' / ' + '  '.repeat(f.depth) + f.name));
    }
    $('dlg_folder_name').value = '';
    const ok = $('dlg_folder_ok');
    const onOk = (ev) => {
        ev.preventDefault();
        const name = $('dlg_folder_name').value.trim();
        const ops = name ? { move: 'folder', folder_name: name } : { move: 'folder', folder_id: sel.value };
        if (!name && !sel.value) return;
        const perm = requestPermissionsForOps([ops]);
        cleanup();
        dlg.close();
        perm.then(granted => {
            if (!granted) return toast(t('inbox_permission_denied'), { error: true });
            runPlan(messages.map(m => ({ message: m, ops: { ...ops } })), label || describeOps(ops));
        });
    };
    const cleanup = () => { ok.removeEventListener('click', onOk); dlg.removeEventListener('close', cleanup); };
    ok.addEventListener('click', onOk);
    dlg.addEventListener('close', cleanup);
    dlg.showModal();
}

function pickTag(messages, label) {
    const dlg = $('dlg_tag');
    const sel = $('dlg_tag_select');
    sel.textContent = '';
    for (const tag of state.tags) sel.append(h('option', { value: tag.key }, tag.tag));
    $('dlg_tag_new').value = '';
    const ok = $('dlg_tag_ok');
    const onOk = (ev) => {
        ev.preventDefault();
        const newName = $('dlg_tag_new').value.trim();
        if (!newName && !sel.value) return;
        const extra = newName ? ['messagesTags'] : [];
        const perm = requestPermissionsForOps([{ tag_key: 'x' }], extra);
        cleanup();
        dlg.close();
        perm.then(async granted => {
            if (!granted) return toast(t('inbox_permission_denied'), { error: true });
            let key = sel.value;
            if (newName) {
                const existing = state.tags.find(x => x.tag.toLowerCase() === newName.toLowerCase());
                if (existing) {
                    key = existing.key;
                } else {
                    await createTag(newName);
                    state.tags = await browser.messages.tags.list();
                    const created = state.tags.find(x => x.tag.toLowerCase() === newName.toLowerCase());
                    key = created ? created.key : '';
                }
            }
            if (!key) return;
            const ops = { tag_key: key };
            runPlan(messages.map(m => ({ message: m, ops: { ...ops } })), label || describeOps(ops));
        });
    };
    const cleanup = () => { ok.removeEventListener('click', onOk); dlg.removeEventListener('close', cleanup); };
    ok.addEventListener('click', onOk);
    dlg.addEventListener('close', cleanup);
    dlg.showModal();
}

// ---------------------------------------------------------------------------
// Brief and replies
// ---------------------------------------------------------------------------

async function makeBrief() {
    if (state.entries.size === 0 || state.busy) return;
    setBusy(true);
    state.abort = new AbortController();
    const box = $('ia_brief');
    const content = $('ia_brief_content');
    box.classList.remove('hidden');
    content.textContent = t('inbox_brief_loading');
    try {
        const prompt = await buildBriefPrompt([...state.entries.values()], state.categories);
        const answer = await runAIPrompt(prompt, { signal: state.abort.signal });
        const md = window.markdownit({ html: false, linkify: false, breaks: true });
        content.innerHTML = md.render(answer);
    } catch (e) {
        content.textContent = isAbortError(e) ? t('inbox_scan_stopped', ['0']) : t('inbox_error_generic') + ': ' + e.message;
    } finally {
        setBusy(false);
        state.abort = null;
    }
}

function identityNameFor(message) {
    const accountId = message.folder ? message.folder.accountId : '';
    const account = state.accounts.find(a => a.id === accountId);
    return account && account.identities.length > 0 ? account.identities[0].name : '';
}

function openReplyDialog(message, { followup = false } = {}) {
    const dlg = $('dlg_reply');
    $('dlg_reply_title').textContent = followup ? t('inbox_followup_title') : t('inbox_reply_title');
    $('dlg_reply_subject').textContent = (message.subject || '') + ' — ' + (message.author || '');
    $('dlg_reply_intent').value = followup ? t('inbox_followup_default_intent') : '';
    $('dlg_reply_text').value = '';
    $('dlg_reply_status').textContent = '';
    $('dlg_reply_ok').disabled = true;
    const gen = $('dlg_reply_generate');
    let controller = null;
    gen.onclick = async () => {
        gen.disabled = true;
        controller = new AbortController();
        $('dlg_reply_status').textContent = t('inbox_reply_generating');
        try {
            const prompt = await buildReplyPrompt(message, $('dlg_reply_intent').value, identityNameFor(message));
            const answer = await runAIPrompt(prompt, { signal: controller.signal });
            $('dlg_reply_text').value = answer.trim();
            $('dlg_reply_ok').disabled = false;
            $('dlg_reply_status').textContent = '';
        } catch (e) {
            $('dlg_reply_status').textContent = isAbortError(e) ? '' : t('inbox_error_generic') + ': ' + e.message;
        } finally {
            gen.disabled = false;
        }
    };
    $('dlg_reply_text').oninput = () => { $('dlg_reply_ok').disabled = $('dlg_reply_text').value.trim() === ''; };
    $('dlg_reply_ok').onclick = async (ev) => {
        ev.preventDefault();
        const text = $('dlg_reply_text').value;
        dlg.close();
        try {
            await browser.runtime.sendMessage({
                command: 'chatgpt_replyMessage',
                text: textToHtml(text),
                mailMessageId: message.id,
                replyType: followup ? 'reply_all' : '',
            });
        } catch (e) {
            toast(t('inbox_error_generic') + ': ' + e.message, { error: true });
        }
    };
    dlg.onclose = () => { if (controller) controller.abort(); };
    dlg.showModal();
    if (state.aiConfig && state.aiConfig.usable) gen.click();
}

async function openMessage(messageId) {
    try {
        await browser.messageDisplay.open({ messageId, location: 'tab', active: true });
    } catch (e) {
        toast(t('inbox_error_generic') + ': ' + e.message, { error: true });
    }
}

// ---------------------------------------------------------------------------
// Senders and cleanup
// ---------------------------------------------------------------------------

async function scanSenders() {
    if (state.busy) return;
    state.abort = new AbortController();
    setBusy(true);
    const signal = state.abort.signal;
    try {
        await saveScope();
        const scope = getScope();
        // Cleanup works on a wider set than triage: headers only, no AI involved.
        scope.maxMessages = Math.min(5000, Math.max(scope.maxMessages * 5, 1000));
        setProgress('ia_senders_progress', { phase: 'collect', count: 0 });
        const messages = await collectMessages(scope, { signal, onProgress: p => setProgress('ia_senders_progress', p) });
        state.sendersMessages = messages;
        state.senders = await computeSenderStats(messages);
        state.sendersSelected.clear();
        state.sendersFilter = null;
        $('ia_senders_info').textContent = t('inbox_senders_info', [String(messages.length), String(state.senders.length)]);
        renderSenders();
        renderQuickWins();
        // Look up unsubscribe headers of the top senders in the background.
        const top = state.senders.filter(s => s.count >= 2).slice(0, 60);
        let done = 0;
        await runWithConcurrency(top, 3, async (s) => {
            try {
                state.unsubInfo.set(s.email, await getUnsubscribeInfo(s.newestMessage));
            } catch (e) {
                state.unsubInfo.set(s.email, { http: [], mailto: [], oneClick: false });
            }
            done++;
            setProgress('ia_senders_progress', { pct: Math.round(100 * done / top.length), label: t('inbox_progress_lists', [String(done), String(top.length)]) });
        }, signal);
        renderSenders();
        renderQuickWins();
    } catch (e) {
        if (!isAbortError(e)) toast(t('inbox_error_generic') + ': ' + e.message, { error: true });
    } finally {
        setProgress('ia_senders_progress', null);
        setBusy(false);
        state.abort = null;
    }
}

function senderIsList(s) {
    const info = state.unsubInfo.get(s.email);
    return !!info && (info.http.length > 0 || info.mailto.length > 0);
}

function renderSenders() {
    const body = $('ia_senders_body');
    body.textContent = '';
    const q = $('ia_sender_filter').value.trim().toLowerCase();
    const listsOnly = $('ia_senders_lists_only').checked;
    let senders = state.senders.filter(s => {
        if (state.sendersFilter && !state.sendersFilter.has(s.email)) return false;
        if (listsOnly && !senderIsList(s)) return false;
        if (q && !(s.email || '').includes(q) && !(s.name || '').toLowerCase().includes(q)) return false;
        return true;
    });
    if (senders.length === 0) {
        body.append(h('tr', {}, h('td', { colspan: '6', class: 'ia-empty' }, state.senders.length ? t('inbox_senders_none_match') : t('inbox_senders_empty'))));
        renderSendersBulkBar();
        return;
    }
    for (const s of senders.slice(0, 300)) {
        const check = h('input', { type: 'checkbox', checked: state.sendersSelected.has(s.email) });
        check.addEventListener('change', () => {
            check.checked ? state.sendersSelected.add(s.email) : state.sendersSelected.delete(s.email);
            renderSendersBulkBar();
        });
        const info = state.unsubInfo.get(s.email);
        const ruleSel = h('select', { title: t('inbox_sender_rule_info') }, h('option', { value: '' }, t('inbox_sender_rule')));
        for (const c of state.categories.filter(c => c.enabled)) ruleSel.append(h('option', { value: c.id }, getCategoryDisplayName(c)));
        ruleSel.addEventListener('change', async () => {
            if (!ruleSel.value) return;
            const cat = categoryById(ruleSel.value);
            await setSenderRule(s.email, cat.id);
            toast(t('inbox_pinned', [s.email, getCategoryDisplayName(cat)]));
            ruleSel.value = '';
        });
        const unreadPct = Math.round(100 * s.unread / s.count);
        body.append(h('tr', { class: s.unread > 0 ? 'ia-unread' : '' },
            h('td', { class: 'ia-c-check' }, check),
            h('td', { class: 'ia-c-from', style: { width: 'auto', maxWidth: '360px' } },
                h('b', {}, s.name || s.email), senderIsList(s) ? h('span', { class: 'ia-badge list' }, t('inbox_badge_list')) : null,
                h('small', {}, s.email + ' · ' + formatBytes(s.size))),
            h('td', {}, s.count),
            h('td', {}, unreadPct + '%'),
            h('td', { class: 'ia-c-date' }, formatDate(s.newest)),
            h('td', { class: 'ia-c-tools', style: { width: 'auto' } },
                info && (info.http.length || info.mailto.length) ? h('button', { class: 'ia-btn small accent', onclick: () => openUnsubDialog(s) }, t('inbox_unsubscribe')) : null,
                h('button', { class: 'ia-btn small', title: t('inbox_act_read'), onclick: () => bulkAction('read', validMessages(s.messages), s.email + ': ' + t('inbox_act_read')) }, '✉'),
                h('button', { class: 'ia-btn small', title: t('inbox_act_archive'), onclick: () => bulkAction('archive', validMessages(s.messages), s.email + ': ' + t('inbox_act_archive')) }, '\u{1F4E6}'),
                h('button', { class: 'ia-btn small', title: t('inbox_act_trash'), onclick: () => bulkAction('trash', validMessages(s.messages), s.email + ': ' + t('inbox_act_trash')) }, '\u{1F5D1}'),
                ruleSel,
            ),
        ));
    }
    renderSendersBulkBar();
}

// Messages already moved by an earlier action are excluded.
const movedIds = new Set();
function validMessages(messages) {
    return messages.filter(m => !movedIds.has(m.id));
}

function renderSendersBulkBar() {
    const n = state.sendersSelected.size;
    $('ia_senders_bulkbar').classList.toggle('hidden', n === 0);
    const count = selectedSenderMessages().length;
    $('ia_senders_sel_count').textContent = t('inbox_senders_selected', [String(n), String(count)]);
}

function selectedSenderMessages() {
    return validMessages(state.senders.filter(s => state.sendersSelected.has(s.email)).flatMap(s => s.messages));
}

function renderQuickWins() {
    const box = $('ia_quickwins');
    box.textContent = '';
    if (state.senders.length === 0) return;
    const now = Date.now();
    const msgs = validMessages(state.sendersMessages);

    const neverRead = state.senders.filter(s => s.count >= 3 && s.unread / s.count >= 0.8);
    const neverReadMsgs = validMessages(neverRead.flatMap(s => s.messages));
    if (neverRead.length > 0) {
        box.append(h('div', { class: 'ia-quickwin' },
            h('div', { class: 'ia-big' }, neverRead.length),
            h('p', {}, t('inbox_qw_never_read', [String(neverReadMsgs.length)])),
            h('div', {},
                h('button', { class: 'ia-btn small', onclick: () => { state.sendersFilter = new Set(neverRead.map(s => s.email)); renderSenders(); } }, t('inbox_qw_review')),
                ' ',
                h('button', { class: 'ia-btn small accent', onclick: () => bulkAction('archive', neverReadMsgs, t('inbox_qw_never_read_label')) }, t('inbox_qw_archive', [String(neverReadMsgs.length)])))));
    }

    const old = msgs.filter(m => m.read && !m.flagged && (now - new Date(m.date)) > 90 * 86400000);
    if (old.length > 0) {
        box.append(h('div', { class: 'ia-quickwin' },
            h('div', { class: 'ia-big' }, old.length),
            h('p', {}, t('inbox_qw_old_read')),
            h('div', {}, h('button', { class: 'ia-btn small accent', onclick: () => bulkAction('archive', old, t('inbox_qw_old_read_label')) }, t('inbox_qw_archive', [String(old.length)])))));
    }

    const lists = state.senders.filter(senderIsList);
    const listUnreadOld = validMessages(lists.flatMap(s => s.messages)).filter(m => (now - new Date(m.date)) > 14 * 86400000);
    if (lists.length > 0) {
        box.append(h('div', { class: 'ia-quickwin' },
            h('div', { class: 'ia-big' }, lists.length),
            h('p', {}, t('inbox_qw_lists', [String(listUnreadOld.length)])),
            h('div', {},
                h('button', { class: 'ia-btn small', onclick: () => { $('ia_senders_lists_only').checked = true; state.sendersFilter = null; renderSenders(); } }, t('inbox_qw_review')),
                ' ',
                listUnreadOld.length ? h('button', { class: 'ia-btn small accent', onclick: () => bulkAction('archive', listUnreadOld, t('inbox_qw_lists_label')) }, t('inbox_qw_archive', [String(listUnreadOld.length)])) : null)));
    }

    const big = msgs.filter(m => (m.size || 0) > 5 * 1024 * 1024);
    if (big.length > 0) {
        const total = big.reduce((n, m) => n + (m.size || 0), 0);
        box.append(h('div', { class: 'ia-quickwin' },
            h('div', { class: 'ia-big' }, formatBytes(total)),
            h('p', {}, t('inbox_qw_big', [String(big.length)])),
            h('div', {}, h('button', { class: 'ia-btn small', onclick: () => startScan(big) }, t('inbox_qw_big_review')))));
    }
}

// Runs a plan and keeps the senders tab counters in sync.
async function runPlan(plan, label, source = 'manual') {
    await runPlanCore(plan, label, source);
    for (const item of plan) if (item.record && item.record.moved) movedIds.add(item.message.id);
    if (state.senders.length > 0) {
        for (const s of state.senders) {
            s.messages = validMessages(s.messages);
            s.count = s.messages.length;
            s.unread = s.messages.filter(m => m.read === false).length;
        }
        state.senders = state.senders.filter(s => s.count > 0);
        renderSenders();
        renderQuickWins();
    }
}

function openUnsubDialog(sender) {
    const info = state.unsubInfo.get(sender.email);
    if (!info) return;
    const dlg = $('dlg_unsub');
    const box = $('dlg_unsub_info');
    box.textContent = '';
    let method = '';
    if (info.oneClick) method = t('inbox_unsub_method_oneclick');
    else if (info.http.length > 0) method = t('inbox_unsub_method_web');
    else method = t('inbox_unsub_method_mail');
    box.append(h('div', {}, h('b', {}, sender.name || sender.email), ' <' + sender.email + '>'), h('div', { class: 'ia-muted' }, method));
    const msgs = validMessages(sender.messages);
    $('dlg_unsub_archive_label').textContent = t('inbox_unsub_also_archive', [String(msgs.length)]);
    $('dlg_unsub_archive').checked = true;
    const ok = $('dlg_unsub_ok');
    const onOk = (ev) => {
        ev.preventDefault();
        const alsoArchive = $('dlg_unsub_archive').checked && msgs.length > 0;
        // Request everything needed in the click handler.
        const request = { permissions: alsoArchive ? ['messagesMove'] : [], origins: [] };
        let url = '';
        if (info.oneClick) {
            url = info.http[0];
            request.origins.push(new URL(url).origin + '/*');
        }
        const perm = (request.permissions.length || request.origins.length) ? browser.permissions.request(request) : Promise.resolve(true);
        cleanup();
        dlg.close();
        perm.then(async granted => {
            if (!granted) return toast(t('inbox_permission_denied'), { error: true });
            try {
                if (info.oneClick) {
                    const okPost = await oneClickUnsubscribe(url);
                    if (!okPost) await browser.windows.openDefaultBrowser(url);
                    toast(okPost ? t('inbox_unsub_done', [sender.email]) : t('inbox_unsub_opened_web'));
                } else if (info.http.length > 0) {
                    await browser.windows.openDefaultBrowser(info.http[0]);
                    toast(t('inbox_unsub_opened_web'));
                } else if (info.mailto.length > 0) {
                    const mt = parseMailto(info.mailto[0]);
                    await browser.compose.beginNew({ to: [mt.to], subject: mt.subject, plainTextBody: mt.body, isPlainText: true });
                    toast(t('inbox_unsub_opened_mail'));
                }
            } catch (e) {
                toast(t('inbox_error_generic') + ': ' + e.message, { error: true });
            }
            if (alsoArchive) {
                await runPlan(msgs.map(m => ({ message: m, ops: { move: 'archive' } })), t('inbox_unsubscribe') + ': ' + sender.email);
            }
        });
    };
    const cleanup = () => { ok.removeEventListener('click', onOk); dlg.removeEventListener('close', cleanup); };
    ok.addEventListener('click', onOk);
    dlg.addEventListener('close', cleanup);
    dlg.showModal();
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

function followupRow(message, { title, subtitle, summary, badge, onDraft, onDone }) {
    return h('tr', { class: message.read === false ? 'ia-unread' : '' },
        h('td', { class: 'ia-c-from' }, h('b', {}, title), h('small', {}, subtitle)),
        h('td', { class: 'ia-c-subj' },
            h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openMessage(message.id); } }, message.subject || t('inbox_no_subject')),
            badge ? h('span', { class: 'ia-badge due' }, badge) : null,
            summary ? h('div', { class: 'ia-summary' }, summary) : null),
        h('td', { class: 'ia-c-date' }, formatDate(message.date)),
        h('td', { class: 'ia-c-tools' },
            h('button', { class: 'ia-btn small accent', onclick: onDraft }, '↩ ' + t('inbox_draft')),
            onDone ? h('button', { class: 'ia-btn small', title: t('inbox_done_info'), onclick: onDone }, '✓ ' + t('inbox_done')) : null));
}

function renderNeedsReply() {
    const box = $('ia_needs_reply');
    box.textContent = '';
    const list = [...state.entries.values()]
        .filter(e => e.result.needs_reply || e.result.category === 'reply')
        .sort((a, b) => (a.result.priority - b.result.priority) || (new Date(a.message.date) - new Date(b.message.date)));
    const counter = $('ia_followups_count');
    counter.textContent = list.length;
    counter.classList.toggle('hidden', list.length === 0);
    if (list.length === 0) {
        box.append(h('div', { class: 'ia-empty' }, state.entries.size ? t('inbox_needs_reply_none') : t('inbox_needs_reply_scan_first')));
        return;
    }
    const tbody = h('tbody');
    for (const e of list) {
        tbody.append(followupRow(e.message, {
            title: e.digest.fromName || e.digest.fromEmail,
            subtitle: e.digest.fromEmail,
            summary: e.result.summary,
            badge: e.result.due ? '\u{1F4C5} ' + e.result.due : '',
            onDraft: () => openReplyDialog(e.message),
            onDone: () => {
                const ops = { mark_read: true, unflag: true };
                const perm = requestPermissionsForOps([ops]);
                perm.then(async granted => {
                    if (!granted) return toast(t('inbox_permission_denied'), { error: true });
                    await runPlan([{ message: e.message, ops }], t('inbox_done') + ': ' + (e.message.subject || ''));
                    e.result = { ...e.result, needs_reply: false, category: e.result.category === 'reply' ? 'important' : e.result.category, source: 'user' };
                    await saveTriageResults({ [e.message.headerMessageId]: e.result });
                    renderResults();
                    renderNeedsReply();
                });
            },
        }));
    }
    box.append(h('table', { class: 'ia-table' }, tbody));
}

async function scanFollowups() {
    if (state.busy) return;
    state.abort = new AbortController();
    setBusy(true);
    const signal = state.abort.signal;
    const box = $('ia_waiting');
    try {
        const days = parseInt($('ia_followup_days').value) || 14;
        await browser.storage.sync.set({ inbox_followup_days: days });
        const scope = getScope();
        const unanswered = await findUnansweredSent({ accountIds: scope.accountIds, days, signal, onProgress: p => setProgress('ia_followups_progress', p) });
        let classified = new Map();
        if (state.aiConfig.usable && unanswered.length > 0) {
            setProgress('ia_followups_progress', { pct: 90, label: t('inbox_progress_followups_ai') });
            classified = await classifyFollowups(unanswered, { signal });
        }
        state.waiting = unanswered.filter(u => !classified.has(u.message.id) || classified.get(u.message.id).awaiting)
            .map(u => ({ ...u, summary: classified.get(u.message.id)?.summary || '' }));
        renderWaiting();
    } catch (e) {
        if (!isAbortError(e)) {
            box.textContent = '';
            box.append(h('div', { class: 'ia-empty' }, t('inbox_error_generic') + ': ' + e.message));
        }
    } finally {
        setProgress('ia_followups_progress', null);
        setBusy(false);
        state.abort = null;
    }
}

function renderWaiting() {
    const box = $('ia_waiting');
    box.textContent = '';
    if (state.waiting.length === 0) {
        box.append(h('div', { class: 'ia-empty' }, t('inbox_waiting_none')));
        return;
    }
    const tbody = h('tbody');
    for (const w of state.waiting) {
        tbody.append(followupRow(w.message, {
            title: w.recipients.join(', '),
            subtitle: t('inbox_waiting_days', [String(w.ageDays)]),
            summary: w.summary,
            badge: '',
            onDraft: () => openReplyDialog(w.message, { followup: true }),
            onDone: () => {
                state.waiting = state.waiting.filter(x => x !== w);
                renderWaiting();
            },
        }));
    }
    box.append(h('table', { class: 'ia-table' }, tbody));
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

async function renderActivity() {
    const box = $('ia_activity');
    box.textContent = '';
    const list = await loadActivity();
    if (list.length === 0) {
        box.append(h('div', { class: 'ia-empty' }, t('inbox_activity_empty')));
        return;
    }
    for (const entry of list) {
        const when = new Date(entry.ts).toLocaleString();
        const sourceLabel = entry.source === 'auto' ? t('inbox_activity_source_auto') : t('inbox_activity_source_manual');
        box.append(h('div', { class: 'ia-activity-item' + (entry.undone ? ' undone' : '') },
            h('div', { class: 'ia-when' }, when, h('br'), h('span', { class: 'ia-badge' + (entry.source === 'auto' ? ' list' : '') }, sourceLabel)),
            h('div', { class: 'ia-what' },
                h('div', {}, h('b', {}, entry.label || ''), ' — ', t('inbox_activity_count', [String(entry.count)]),
                    entry.failed ? h('span', { class: 'ia-badge due' }, t('inbox_activity_failed', [String(entry.failed)])) : null),
                entry.samples && entry.samples.length ? h('small', {}, entry.samples.join(' · ')) : null,
                entry.errors && entry.errors.length ? h('small', {}, entry.errors.join(' · ')) : null),
            entry.undone ? h('span', { class: 'ia-badge' }, t('inbox_activity_undone'))
                : (entry.undoable ? h('button', { class: 'ia-btn small', onclick: () => doUndo(entry.id) }, '↶ ' + t('inbox_undo')) : null)));
    }
}

async function doUndo(entryId) {
    const perm = requestPermissionsForOps([{ move: 'archive', mark_read: true }]);
    const granted = await perm;
    if (!granted) return toast(t('inbox_permission_denied'), { error: true });
    setBusy(true);
    try {
        const res = await undoActivity(entryId);
        toast(t('inbox_undo_done', [String(res.restored)]) + (res.missing ? ' ' + t('inbox_undo_missing', [String(res.missing)]) : ''));
    } catch (e) {
        toast(t('inbox_error_generic') + ': ' + e.message, { error: true });
    } finally {
        setBusy(false);
        renderActivity();
    }
}

// ---------------------------------------------------------------------------
// Tabs and init
// ---------------------------------------------------------------------------

function switchTab(name) {
    document.querySelectorAll('.ia-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.ia-tab').forEach(s => s.classList.toggle('hidden', s.id !== 'tab_' + name));
    if (name === 'activity') renderActivity();
}

function openSettings() {
    browser.tabs.create({ url: '/pages/inbox/mzta-inbox-settings.html' });
}

async function loadSelectionFromContextMenu() {
    const data = await browser.storage.session.get({ _inbox_selection: [] });
    await browser.storage.session.remove('_inbox_selection');
    const messages = [];
    for (const id of data._inbox_selection || []) {
        try {
            messages.push(await browser.messages.get(id));
        } catch (e) {
            console.warn('[ThunderAI | Inbox] Selected message not found: ' + id);
        }
    }
    return messages;
}

document.addEventListener('DOMContentLoaded', async () => {
    const prefs = await browser.storage.sync.get({
        do_debug: prefs_default.do_debug,
        inbox_scan_accounts: prefs_default.inbox_scan_accounts,
        inbox_scan_folder_mode: prefs_default.inbox_scan_folder_mode,
        inbox_scan_days: prefs_default.inbox_scan_days,
        inbox_scan_max: prefs_default.inbox_scan_max,
        inbox_scan_unread_only: prefs_default.inbox_scan_unread_only,
        inbox_followup_days: prefs_default.inbox_followup_days,
    });
    state.log = new taLogger('mzta-inbox-page', prefs.do_debug);
    i18n.updateDocument();

    state.accounts = await getAccountsWithIdentities();
    state.folders = await listAllFolders();
    state.categories = await loadCategories();
    state.tags = await browser.messages.tags.list();

    renderScope(prefs);
    $('ia_followup_days').value = String(prefs.inbox_followup_days);
    await refreshProvider();
    renderResults();
    renderNeedsReply();
    renderActivity();

    // Events
    $('btn_scan').addEventListener('click', () => startScan());
    $('btn_stop').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
    $('btn_settings').addEventListener('click', openSettings);
    $('btn_api_settings').addEventListener('click', openSettings);
    $('btn_brief').addEventListener('click', makeBrief);
    $('btn_brief_close').addEventListener('click', () => $('ia_brief').classList.add('hidden'));
    $('btn_apply_suggested').addEventListener('click', applyAllSuggested);
    $('btn_clear_selection').addEventListener('click', () => { state.selected.clear(); renderResults(); });
    $('ia_folder_mode').addEventListener('change', () => { updateFolderModeUI(); saveScope(); });
    ['ia_days', 'ia_max', 'ia_unread_only'].forEach(id => $(id).addEventListener('change', saveScope));
    document.querySelectorAll('.ia-tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.querySelectorAll('[data-bulk]').forEach(b => b.addEventListener('click', () => {
        bulkAction(b.dataset.bulk, selectedMessages(), bulkLabel(b.dataset.bulk, state.selected.size));
    }));
    $('ia_bulk_category').addEventListener('change', async (ev) => {
        const id = ev.target.value;
        if (!id) return;
        const changes = {};
        for (const msgId of state.selected) {
            const e = state.entries.get(msgId);
            if (!e) continue;
            e.result = { ...e.result, category: id, source: 'user' };
            changes[e.message.headerMessageId] = e.result;
        }
        await saveTriageResults(changes);
        renderResults();
        renderNeedsReply();
    });
    $('btn_scan_senders').addEventListener('click', scanSenders);
    $('ia_sender_filter').addEventListener('input', () => { state.sendersFilter = null; renderSenders(); });
    $('ia_senders_lists_only').addEventListener('change', renderSenders);
    $('ia_senders_check_all').addEventListener('change', (ev) => {
        for (const row of state.senders) ev.target.checked ? state.sendersSelected.add(row.email) : state.sendersSelected.delete(row.email);
        renderSenders();
    });
    document.querySelectorAll('[data-sbulk]').forEach(b => b.addEventListener('click', () => {
        const msgs = selectedSenderMessages();
        bulkAction(b.dataset.sbulk, msgs, bulkLabel(b.dataset.sbulk, msgs.length));
    }));
    $('btn_scan_followups').addEventListener('click', scanFollowups);
    $('btn_refresh_activity').addEventListener('click', renderActivity);
    $('btn_clear_activity').addEventListener('click', async () => {
        if (!confirm(t('inbox_activity_clear_confirm'))) return;
        await clearActivity();
        renderActivity();
    });

    browser.storage.onChanged.addListener(async (changes, area) => {
        if (area === 'local' && (changes._inbox_categories)) {
            state.categories = await loadCategories();
            renderResults();
        }
        if (area === 'local' && changes._special_prompts) await refreshProvider();
        if (area === 'sync' && Object.keys(changes).some(k => k.endsWith('_connection_type') || k.endsWith('_model') || k.includes('use_specific_integration'))) {
            await refreshProvider();
            updateTriageButtons();
        }
    });

    // Opening the page resets the "needs attention" badge.
    browser.runtime.sendMessage({ command: 'inbox_reset_attention' }).catch(() => {});

    // Launched from a context menu?
    const params = new URLSearchParams(window.location.search);
    if (params.get('folders')) {
        const ids = params.get('folders').split(',');
        const accountIds = [...new Set(state.folders.filter(f => ids.includes(f.id)).map(f => f.accountId))];
        document.querySelectorAll('#ia_accounts input').forEach(i => {
            i.checked = accountIds.includes(i.value);
            i.closest('.ia-chip').classList.toggle('active', i.checked);
        });
        $('ia_folder_mode').value = 'custom';
        renderCustomFolders(ids);
        updateFolderModeUI();
    }
    if (params.get('selection')) {
        const messages = await loadSelectionFromContextMenu();
        if (messages.length > 0) startScan(messages);
    }
}, { once: true });
