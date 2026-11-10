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

// Inbox Assistant settings page. See claude-spec/07-inbox-assistant.md

import {
    prefs_default,
    integration_options_config
} from '../../options/mzta-options-default.js';
import { taLogger } from '../../js/mzta-logger.js';
import { getSpecialPrompts, setSpecialPrompts } from '../../js/mzta-prompts.js';
import { isAPIKeyValue, setTomSelectBorder, normalizeStringList } from '../../js/mzta-utils.js';
import { initializeSpecificIntegrationUI } from '../_lib/connection-ui.js';
import {
    INBOX_TRIAGE_PROMPT_ID,
    INBOX_MOVE_ACTIONS,
    DEFAULT_CATEGORIES,
    loadCategories,
    saveCategories,
    newCustomCategoryId,
    getCategoryDisplayName,
    getCategoryDescription,
    listAllFolders,
    loadSenderRules,
    saveSenderRules,
    clearTriageCache,
    loadTriageCache,
} from '../../js/mzta-inbox-engine.js';
import { opsFromCategory, permissionsForOps } from '../../js/mzta-inbox-actions.js';

const PREFIX = 'inbox';
let taLog = console;
let categories = [];
let folders = [];
let tags = [];

const $ = id => document.getElementById(id);
const t = (key, subs) => browser.i18n.getMessage(key, subs) || key;

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

let toastTimer = null;
function toast(message, error = false) {
    const el = $('ia_toast');
    $('ia_toast_text').textContent = message;
    el.classList.toggle('error', error);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

const NUMBER_LIMITS = {
    inbox_snippet_length: [0, 4000],
    inbox_batch_size: [1, 50],
    inbox_parallel_requests: [1, 4],
};

// Generic save, same behavior as the other ThunderAI settings pages.
function saveOptions(e) {
    const element = e.target;
    if (!element.id) return;
    const options = {};
    switch (element.type) {
        case 'checkbox':
            options[element.id] = element.checked;
            break;
        case 'number': {
            let v = element.valueAsNumber;
            const lim = NUMBER_LIMITS[element.id];
            if (Number.isNaN(v)) v = prefs_default[element.id] ?? 0;
            if (lim) v = Math.min(lim[1], Math.max(lim[0], v));
            element.value = v;
            options[element.id] = v;
            break;
        }
        case 'text':
        case 'password':
            options[element.id] = element.value.trim();
            break;
        case 'select-one':
            options[element.id] = element.value;
            break;
        case 'textarea':
            options[element.id] = element.value;
            break;
        default:
            return;
    }
    browser.storage.sync.set(options);
}

async function restoreOptions() {
    const getting = await browser.storage.sync.get(prefs_default);
    const specialPrompts = await getSpecialPrompts();
    const prompt = specialPrompts.find(p => p.id === INBOX_TRIAGE_PROMPT_ID);
    // The Inbox Assistant needs an API: when the global connection is ChatGPT Web, Mistral AI is proposed.
    const fallbackType = getting.connection_type === 'chatgpt_web' ? 'mistral_api' : getting.connection_type;
    getting[PREFIX + '_connection_type'] = (prompt && prompt.api_type) ? prompt.api_type : fallbackType;
    for (const [integration, options] of Object.entries(integration_options_config)) {
        for (const key of Object.keys(options)) {
            const propName = `${integration}_${key}`;
            const promptValue = prompt ? prompt[propName] : undefined;
            getting[`${PREFIX}_${propName}`] = (promptValue !== undefined && promptValue !== '') ? promptValue : getting[propName];
        }
    }

    document.querySelectorAll('.option-input').forEach(element => {
        if (!element.id) return;
        const value = getting[element.id];
        taLog.log('Restoring ' + element.id + ' = ' + (isAPIKeyValue(element.id) ? '****' : value));
        switch (element.type) {
            case 'checkbox':
                element.checked = !!value;
                break;
            case 'number':
                element.value = value ?? 0;
                break;
            case 'text':
            case 'password':
            case 'textarea':
                element.value = value ?? '';
                break;
            default:
                if (element.tagName === 'SELECT') {
                    const restoreValue = value ?? '';
                    const exists = Array.from(element.options).some(o => o.value === restoreValue);
                    if (element.tomselect) {
                        if (!exists && restoreValue !== '') element.tomselect.addOption({ value: restoreValue, text: restoreValue });
                        element.tomselect.setValue(restoreValue, true);
                        setTomSelectBorder(element.tomselect);
                    } else {
                        if (!exists && restoreValue !== '') element.add(new Option(restoreValue, restoreValue));
                        element.value = restoreValue;
                        if (element.value === '') element.selectedIndex = -1;
                    }
                }
        }
    });
}

// ---------------------------------------------------------------------------
// Categories editor
// ---------------------------------------------------------------------------

function markCategoriesDirty() {
    $('cat_unsaved').classList.remove('hidden');
}

function folderSelect(cat) {
    const sel = h('select', { class: 'cat-folder' }, h('option', { value: '' }, t('inbox_cat_folder_choose')), h('option', { value: '__name__' }, t('inbox_cat_folder_by_name')));
    for (const f of folders) {
        sel.append(h('option', { value: f.id, selected: f.id === cat.folder_id }, f.accountName + ' / ' + '  '.repeat(f.depth) + f.name));
    }
    if (!cat.folder_id && cat.folder_name) sel.value = '__name__';
    return sel;
}

function categoryRow(cat) {
    const isOther = cat.id === 'other';
    const tr = h('tr', { dataset: { id: cat.id, builtin: cat.builtin ? '1' : '0' } });
    const moveSel = h('select', { class: 'cat-move' });
    for (const a of INBOX_MOVE_ACTIONS) moveSel.append(h('option', { value: a, selected: a === cat.move }, t('inbox_move_' + a)));
    const fSel = folderSelect(cat);
    const fName = h('input', { type: 'text', class: 'cat-folder-name', value: cat.folder_name || '', placeholder: t('inbox_cat_folder_name_placeholder') });
    const tagSel = h('select', { class: 'cat-tag' }, h('option', { value: '' }, t('inbox_cat_no_tag')));
    for (const tg of tags) tagSel.append(h('option', { value: tg.key, selected: tg.key === cat.tag_key }, tg.tag));
    const updateVisibility = () => {
        fSel.classList.toggle('hidden', moveSel.value !== 'folder');
        fName.classList.toggle('hidden', !(moveSel.value === 'folder' && fSel.value === '__name__'));
    };
    moveSel.addEventListener('change', updateVisibility);
    fSel.addEventListener('change', updateVisibility);
    updateVisibility();

    tr.append(
        h('td', {}, h('input', { type: 'checkbox', class: 'cat-enabled', checked: cat.enabled, disabled: isOther, title: isOther ? t('inbox_cat_other_required') : '' })),
        h('td', {}, h('input', { type: 'color', class: 'cat-color', value: cat.color })),
        h('td', {}, h('input', { type: 'text', class: 'cat-name', value: cat.name || '', placeholder: cat.builtin ? getCategoryDisplayName({ id: cat.id }) : t('inbox_cat_name_placeholder') })),
        h('td', {}, h('textarea', { class: 'cat-desc', rows: '2', placeholder: cat.builtin ? getCategoryDescription({ id: cat.id }) : t('inbox_cat_desc_placeholder') }, cat.description || '')),
        h('td', {}, h('div', { class: 'ia-cat-actions' },
            moveSel, fSel, fName, tagSel,
            h('label', { class: 'ia-inline' }, h('input', { type: 'checkbox', class: 'cat-read', checked: cat.mark_read }), t('inbox_act_read')),
            h('label', { class: 'ia-inline' }, h('input', { type: 'checkbox', class: 'cat-flag', checked: cat.flag }), t('inbox_act_flag')))),
        h('td', {}, h('input', { type: 'checkbox', class: 'cat-auto', checked: cat.auto, title: t('inbox_cat_col_auto_info') })),
        h('td', {}, cat.builtin
            ? h('button', { class: 'ia-btn small ghost', title: t('reset_default'), onclick: () => resetCategory(cat.id) }, '↺')
            : h('button', { class: 'ia-btn small danger', title: t('inbox_cat_delete'), onclick: () => deleteCategory(cat.id) }, '✕')),
    );
    tr.addEventListener('input', markCategoriesDirty);
    tr.addEventListener('change', markCategoriesDirty);
    return tr;
}

function renderCategories() {
    const body = $('cat_body');
    body.textContent = '';
    for (const cat of categories) body.append(categoryRow(cat));
    renderRuleCategorySelect();
    renderAutoSummary();
}

function readCategoriesFromUI() {
    const out = [];
    for (const tr of $('cat_body').querySelectorAll('tr')) {
        const id = tr.dataset.id;
        const prev = categories.find(c => c.id === id) || {};
        const move = tr.querySelector('.cat-move').value;
        const folderVal = tr.querySelector('.cat-folder').value;
        out.push({
            ...prev,
            id,
            enabled: id === 'other' ? true : tr.querySelector('.cat-enabled').checked,
            color: tr.querySelector('.cat-color').value,
            name: tr.querySelector('.cat-name').value.trim(),
            description: tr.querySelector('.cat-desc').value.trim(),
            move,
            folder_id: move === 'folder' && folderVal && folderVal !== '__name__' ? folderVal : '',
            folder_name: move === 'folder' && folderVal === '__name__' ? tr.querySelector('.cat-folder-name').value.trim() : '',
            tag_key: tr.querySelector('.cat-tag').value,
            mark_read: tr.querySelector('.cat-read').checked,
            flag: tr.querySelector('.cat-flag').checked,
            auto: tr.querySelector('.cat-auto').checked,
        });
    }
    return out;
}

function validateCategories(list) {
    for (const c of list) {
        if (!c.builtin && !c.name) return t('inbox_cat_error_name');
        if (!c.builtin && !c.description) return t('inbox_cat_error_desc', [c.name]);
        if (c.move === 'folder' && !c.folder_id && !c.folder_name) return t('inbox_cat_error_folder', [c.name || getCategoryDisplayName(c)]);
    }
    return null;
}

function resetCategory(id) {
    const def = DEFAULT_CATEGORIES.find(d => d.id === id);
    categories = readCategoriesFromUI().map(c => c.id === id ? { ...def, id, builtin: true, enabled: true, name: '', description: '', folder_id: '', folder_name: '', tag_key: '' } : c);
    renderCategories();
    markCategoriesDirty();
}

function deleteCategory(id) {
    const c = categories.find(x => x.id === id);
    if (!confirm(t('inbox_cat_delete_confirm', [c ? (c.name || id) : id]))) return;
    categories = readCategoriesFromUI().filter(x => x.id !== id);
    renderCategories();
    markCategoriesDirty();
}

function addCategory() {
    categories = readCategoriesFromUI();
    const id = newCustomCategoryId(categories);
    const other = categories.findIndex(c => c.id === 'other');
    const cat = { id, name: '', description: '', builtin: false, enabled: true, color: '#0c8599', move: 'none', folder_id: '', folder_name: '', tag_key: '', mark_read: false, flag: false, auto: false };
    categories.splice(other > -1 ? other : categories.length, 0, cat);
    renderCategories();
    markCategoriesDirty();
    const row = $('cat_body').querySelector(`tr[data-id="${id}"] .cat-name`);
    if (row) row.focus();
}

function saveCategoriesClick() {
    const list = readCategoriesFromUI();
    const error = validateCategories(list);
    if (error) {
        toast(error, true);
        return;
    }
    // Automatic actions run in the background, where permissions cannot be requested:
    // request them now, inside the click handler.
    const autoOps = list.filter(c => c.auto && c.enabled).map(opsFromCategory);
    const permissions = permissionsForOps(autoOps);
    const perm = permissions.length > 0 ? browser.permissions.request({ permissions }) : Promise.resolve(true);
    perm.then(async granted => {
        if (!granted) toast(t('inbox_permission_denied_auto'), true);
        await saveCategories(list);
        categories = await loadCategories();
        renderCategories();
        $('cat_unsaved').classList.add('hidden');
        toast(t('inbox_saved'));
    });
}

function renderAutoSummary() {
    const autoCats = categories.filter(c => c.auto && c.enabled);
    $('auto_summary').textContent = autoCats.length > 0
        ? t('inbox_settings_auto_summary', [autoCats.map(c => getCategoryDisplayName(c)).join(', ')])
        : t('inbox_settings_auto_summary_none');
}

// ---------------------------------------------------------------------------
// Sender rules
// ---------------------------------------------------------------------------

function renderRuleCategorySelect() {
    const sel = $('rule_category');
    const prev = sel.value;
    sel.textContent = '';
    for (const c of categories.filter(c => c.enabled)) sel.append(h('option', { value: c.id }, getCategoryDisplayName(c)));
    if (prev) sel.value = prev;
}

async function renderRules() {
    const rules = await loadSenderRules();
    const body = $('rules_body');
    body.textContent = '';
    const entries = Object.entries(rules).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        body.append(h('tr', {}, h('td', { class: 'ia-empty' }, t('inbox_settings_rules_none'))));
        return;
    }
    for (const [pattern, catId] of entries) {
        const cat = categories.find(c => c.id === catId);
        body.append(h('tr', {},
            h('td', {}, h('b', {}, pattern)),
            h('td', {}, cat ? getCategoryDisplayName(cat) : catId + ' (' + t('inbox_settings_rule_missing') + ')'),
            h('td', { style: { textAlign: 'right' } }, h('button', {
                class: 'ia-btn small danger', onclick: async () => {
                    const r = await loadSenderRules();
                    delete r[pattern];
                    await saveSenderRules(r);
                    renderRules();
                },
            }, '✕'))));
    }
}

async function addRule() {
    const pattern = $('rule_sender').value.trim().toLowerCase();
    if (!/^(@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/.test(pattern)) {
        toast(t('inbox_settings_rule_invalid'), true);
        return;
    }
    const rules = await loadSenderRules();
    rules[pattern] = $('rule_category').value;
    await saveSenderRules(rules);
    $('rule_sender').value = '';
    renderRules();
}

// ---------------------------------------------------------------------------
// Auto-sort accounts, protected senders, prompt
// ---------------------------------------------------------------------------

async function renderAutoAccounts() {
    const prefs = await browser.storage.sync.get({ inbox_auto_accounts: prefs_default.inbox_auto_accounts });
    const accounts = await browser.accounts.list(false);
    const box = $('auto_accounts');
    box.textContent = '';
    for (const a of accounts) {
        const checked = prefs.inbox_auto_accounts.includes(a.id);
        const input = h('input', { type: 'checkbox', value: a.id, checked });
        const chip = h('label', { class: 'ia-chip' + (checked ? ' active' : '') }, input, a.name);
        input.addEventListener('change', () => {
            chip.classList.toggle('active', input.checked);
            const ids = [...box.querySelectorAll('input:checked')].map(i => i.value);
            browser.storage.sync.set({ inbox_auto_accounts: ids });
        });
        box.append(chip);
    }
}

async function renderCacheInfo() {
    const cache = await loadTriageCache();
    $('cache_info').textContent = t('inbox_settings_cache_count', [String(Object.keys(cache).length)]);
}

async function setupPrompt() {
    const textarea = $('triage_prompt');
    const saveBtn = $('btn_save_prompt');
    const resetBtn = $('btn_reset_prompt');
    const defaultText = t('prompt_inbox_triage_full_text');
    let specialPrompts = await getSpecialPrompts();
    let prompt = specialPrompts.find(p => p.id === INBOX_TRIAGE_PROMPT_ID);
    let current = (!prompt || !prompt.text || prompt.text === 'prompt_inbox_triage_full_text') ? defaultText : prompt.text;
    textarea.value = current;
    const refresh = () => {
        saveBtn.disabled = textarea.value === current;
        resetBtn.disabled = textarea.value === defaultText;
        $('prompt_unsaved').classList.toggle('hidden', saveBtn.disabled);
    };
    textarea.addEventListener('input', refresh);
    resetBtn.addEventListener('click', () => { textarea.value = defaultText; refresh(); });
    saveBtn.addEventListener('click', async () => {
        if (textarea.value.trim() === '') textarea.value = defaultText;
        specialPrompts = await getSpecialPrompts();
        prompt = specialPrompts.find(p => p.id === INBOX_TRIAGE_PROMPT_ID);
        if (!prompt) return;
        prompt.text = textarea.value;
        await setSpecialPrompts(specialPrompts);
        current = textarea.value;
        refresh();
        toast(t('inbox_saved'));
    });
    refresh();
}

document.addEventListener('DOMContentLoaded', async () => {
    const prefs = await browser.storage.sync.get({
        do_debug: prefs_default.do_debug,
        inbox_protected_senders: prefs_default.inbox_protected_senders,
    });
    taLog = new taLogger('mzta-inbox-settings', prefs.do_debug);

    await initializeSpecificIntegrationUI({
        prefix: PREFIX,
        promptId: INBOX_TRIAGE_PROMPT_ID,
        taLog: taLog,
        restoreOptionsCallback: restoreOptions,
    });

    i18n.updateDocument();

    document.querySelectorAll('.option-input').forEach(el => el.addEventListener('change', saveOptions));

    $('inbox_use_specific_integration').addEventListener('change', (ev) => {
        if (!ev.target.checked) browser.storage.sync.set({ [PREFIX + '_connection_type']: '' });
    });

    // Enabling auto-sort or contact protection needs permissions: request them in the click handler.
    $('inbox_auto_sort').addEventListener('click', (ev) => {
        if (!ev.target.checked) return;
        const autoOps = categories.filter(c => c.auto && c.enabled).map(opsFromCategory);
        const permissions = [...new Set(['messagesMove', 'messagesUpdate', ...permissionsForOps(autoOps)])];
        browser.permissions.request({ permissions }).then(granted => {
            if (!granted) {
                ev.target.checked = false;
                browser.storage.sync.set({ inbox_auto_sort: false });
                toast(t('inbox_permission_denied_auto'), true);
            }
        });
    });
    $('inbox_protect_contacts').addEventListener('click', (ev) => {
        if (!ev.target.checked) return;
        browser.permissions.request({ permissions: ['addressBooks'] }).then(granted => {
            if (!granted) {
                ev.target.checked = false;
                browser.storage.sync.set({ inbox_protect_contacts: false });
                toast(t('inbox_permission_denied'), true);
            }
        });
    });

    folders = await listAllFolders();
    tags = await browser.messages.tags.list();
    categories = await loadCategories();
    renderCategories();
    renderRules();
    renderAutoAccounts();
    renderCacheInfo();
    setupPrompt();

    const protectedArea = $('protected_senders');
    protectedArea.value = (prefs.inbox_protected_senders || []).join('\n');
    protectedArea.addEventListener('input', () => $('protected_unsaved').classList.remove('hidden'));
    $('btn_save_protected').addEventListener('click', async () => {
        const list = normalizeStringList(protectedArea.value.replace(/;/g, '\n'), 2).filter(Boolean);
        await browser.storage.sync.set({ inbox_protected_senders: list });
        protectedArea.value = list.join('\n');
        $('protected_unsaved').classList.add('hidden');
        toast(t('inbox_saved'));
    });

    $('btn_add_category').addEventListener('click', addCategory);
    $('btn_save_categories').addEventListener('click', saveCategoriesClick);
    $('btn_add_rule').addEventListener('click', addRule);
    $('btn_open_assistant').addEventListener('click', () => browser.runtime.sendMessage({ command: 'inbox_open' }));
    $('btn_clear_cache').addEventListener('click', async () => {
        if (!confirm(t('inbox_settings_cache_confirm'))) return;
        await clearTriageCache();
        renderCacheInfo();
        toast(t('inbox_saved'));
    });
}, { once: true });
