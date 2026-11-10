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

// Background auto-sort for the Inbox Assistant: classifies new mail and applies the
// actions of the categories marked "auto". Runs only when inbox_auto_sort is enabled.
// See claude-spec/07-inbox-assistant.md

import { prefs_default } from '../options/mzta-options-default.js';
import { taLogger } from './mzta-logger.js';
import {
    triageMessages,
    loadCategories,
    getInboxPrefs,
    getInboxAIConfig,
    getCategoryDisplayName,
} from './mzta-inbox-engine.js';
import {
    executePlan,
    opsFromCategory,
    opsIsEmpty,
    permissionsForOps,
    isMessageProtected,
    addActivity,
} from './mzta-inbox-actions.js';

const QUEUE_DELAY_MS = 5000;        // wait for a burst of new mail to settle
const MAX_PER_RUN = 100;            // never classify more than this per run
const MAX_AGE_MS = 3 * 86400000;    // ignore "new" mail older than 3 days (e.g. first sync of an account)
const STORAGE_ATTENTION = '_inbox_attention_count';

export const INBOX_PAGE_URL = '/pages/inbox/mzta-inbox.html';

export class taInboxAutoSort {

    queue = [];
    timer = null;
    running = false;
    log = null;

    constructor(do_debug = false) {
        this.log = new taLogger('mzta-inbox-auto', do_debug);
    }

    setDebug(do_debug) {
        this.log.changeDebug(do_debug);
    }

    // Called from the onNewMailReceived listener.
    async enqueue(folder, messages, prefs) {
        if (!prefs.inbox_auto_sort) return;
        if (prefs.inbox_auto_only_inbox && !(folder.specialUse || []).includes('inbox')) {
            this.log.log('Skipping folder (not an inbox): ' + folder.name);
            return;
        }
        const accounts = prefs.inbox_auto_accounts || [];
        if (accounts.length > 0 && !accounts.includes(folder.accountId)) {
            this.log.log('Skipping account (not enabled): ' + folder.accountId);
            return;
        }
        const now = Date.now();
        for (const m of messages) {
            if (m.junk) continue;
            if (m.date && (now - new Date(m.date).getTime()) > MAX_AGE_MS) continue;
            if (!this.queue.some(q => q.id === m.id)) this.queue.push(m);
        }
        this.schedule();
    }

    schedule(delay = QUEUE_DELAY_MS) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(e => console.error('[ThunderAI | Inbox auto-sort] ' + e));
        }, delay);
    }

    async flush() {
        if (this.running) {
            this.schedule();
            return;
        }
        if (this.queue.length === 0) return;
        this.running = true;
        try {
            const batch = this.queue.splice(0, MAX_PER_RUN);
            if (this.queue.length > 0) this.schedule();
            await this.process(batch);
        } finally {
            this.running = false;
        }
    }

    async process(batch) {
        const aiConfig = await getInboxAIConfig();
        if (!aiConfig.usable) {
            this.log.warn('Auto-sort skipped: no API integration configured.');
            return;
        }
        // Messages may have been moved meanwhile (e.g. by the spam filter): refresh them.
        const messages = [];
        for (const m of batch) {
            try {
                const fresh = await browser.messages.get(m.id);
                if (fresh && !fresh.junk) messages.push(fresh);
            } catch (e) {
                this.log.log('Message ' + m.id + ' is gone, skipping.');
            }
        }
        if (messages.length === 0) return;

        const prefs = await getInboxPrefs();
        const categories = await loadCategories();
        const results = await triageMessages(messages, { useCache: true, inboxPrefs: prefs, categories });

        const plan = [];
        let attention = 0;
        let skipped = 0;
        for (const m of messages) {
            const entry = results.get(m.id);
            if (!entry) continue;
            const cat = categories.find(c => c.id === entry.result.category);
            if (!cat) continue;
            if (['reply', 'action'].includes(cat.id) || entry.result.needs_reply) attention++;
            if (!cat.auto) continue;
            const ops = opsFromCategory(cat);
            if (opsIsEmpty(ops)) continue;
            const isProtected = await isMessageProtected(m, {
                protectedSenders: prefs.inbox_protected_senders,
                protectContacts: prefs.inbox_protect_contacts,
                skipFlagged: prefs.inbox_skip_flagged,
            });
            // Mail from protected senders, contacts or flagged mail is never touched automatically.
            if (isProtected) {
                skipped++;
                continue;
            }
            plan.push({ message: m, ops, category: cat });
        }

        if (plan.length > 0) {
            const needed = permissionsForOps(plan.map(p => p.ops));
            const granted = needed.length === 0 || await browser.permissions.contains({ permissions: needed });
            if (!granted) {
                // Permissions can only be requested from a user action: report it in the activity log.
                await addActivity({
                    source: 'auto',
                    label: browser.i18n.getMessage('inbox_activity_missing_permissions'),
                    count: 0,
                    failed: plan.length,
                    errors: [needed.join(', ')],
                    records: [],
                });
            } else {
                const byCat = {};
                for (const p of plan) byCat[getCategoryDisplayName(p.category)] = (byCat[getCategoryDisplayName(p.category)] || 0) + 1;
                const label = browser.i18n.getMessage('inbox_activity_auto_label') + ': ' + Object.entries(byCat).map(([k, v]) => k + ' ' + v).join(', ');
                const res = await executePlan(plan, { source: 'auto', label });
                this.log.log('Auto-sort applied: ' + res.done + ' done, ' + res.failed + ' failed, ' + skipped + ' protected.');
            }
        }

        if (attention > 0) await this.addAttention(attention);
    }

    async addAttention(n) {
        const stored = (await browser.storage.local.get({ [STORAGE_ATTENTION]: 0 }))[STORAGE_ATTENTION] || 0;
        const total = stored + n;
        await browser.storage.local.set({ [STORAGE_ATTENTION]: total });
        await updateInboxBadge(total);
    }
}

export async function updateInboxBadge(count = null) {
    const prefs = await browser.storage.sync.get({ inbox_show_badge: prefs_default.inbox_show_badge });
    if (count === null) {
        count = (await browser.storage.local.get({ [STORAGE_ATTENTION]: 0 }))[STORAGE_ATTENTION] || 0;
    }
    const text = (prefs.inbox_show_badge && count > 0) ? String(count > 99 ? '99+' : count) : '';
    await browser.browserAction.setBadgeText({ text });
    if (text) await browser.browserAction.setBadgeBackgroundColor({ color: '#d9480f' });
}

export async function resetInboxAttention() {
    await browser.storage.local.set({ [STORAGE_ATTENTION]: 0 });
    await updateInboxBadge(0);
}

// Opens the Inbox Assistant tab, or focuses it when already open.
export async function openInboxAssistant(params = '') {
    const base = browser.runtime.getURL(INBOX_PAGE_URL.slice(1));
    const tabs = await browser.tabs.query({});
    const existing = tabs.find(t => t.url && t.url.startsWith(base));
    if (existing && !params) {
        await browser.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
        return existing;
    }
    if (existing) await browser.tabs.remove(existing.id);
    return await browser.tabs.create({ url: INBOX_PAGE_URL + (params ? '?' + params : '') });
}
