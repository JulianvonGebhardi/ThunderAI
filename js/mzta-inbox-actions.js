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

// Inbox Assistant actions: applies tag/flag/read changes and moves to messages,
// records every change in an activity log and can undo it.
// See claude-spec/07-inbox-assistant.md

import { getSpecialFolder, isProtectedSender, parseAuthor } from './mzta-inbox-engine.js';

const STORAGE_ACTIVITY = '_inbox_activity';
const ACTIVITY_MAX = 200;
const UNDO_KEEP = 50;          // newest entries that keep their undo data
const UNDO_MAX_RECORDS = 3000; // larger operations are logged without undo data

// An operation set applied to one message:
// { mark_read, mark_unread, flag, unflag, tag_key, untag_key, move: 'none'|'archive'|'folder'|'trash'|'junk', folder_id, folder_name, not_junk }
export function opsFromCategory(category) {
    return {
        mark_read: !!category.mark_read,
        flag: !!category.flag,
        tag_key: category.tag_key || '',
        move: category.move || 'none',
        folder_id: category.folder_id || '',
        folder_name: category.folder_name || '',
    };
}

export function opsIsEmpty(ops) {
    return !ops.mark_read && !ops.mark_unread && !ops.flag && !ops.unflag && !ops.tag_key && !ops.untag_key && !ops.not_junk && (!ops.move || ops.move === 'none');
}

// Permissions needed by a list of ops. Must be requested from a user action handler.
export function permissionsForOps(opsList) {
    const perms = new Set();
    for (const ops of opsList) {
        if (ops.mark_read || ops.mark_unread || ops.flag || ops.unflag || ops.tag_key || ops.untag_key || ops.not_junk || ops.move === 'junk') perms.add('messagesUpdate');
        if (ops.move && ops.move !== 'none') perms.add('messagesMove');
        if (ops.move === 'folder' && !ops.folder_id && ops.folder_name) perms.add('accountsFolders');
    }
    return [...perms];
}

// Call this FIRST in a click handler (before any other await) to keep the user gesture.
export function requestPermissionsForOps(opsList, extra = []) {
    const permissions = [...new Set([...permissionsForOps(opsList), ...extra])];
    if (permissions.length === 0) return Promise.resolve(true);
    return browser.permissions.request({ permissions });
}

// Returns true when an automatic or bulk-suggested action must not touch this message.
export async function isMessageProtected(message, { protectedSenders = [], protectContacts = false, skipFlagged = true } = {}) {
    if (skipFlagged && message.flagged) return 'flagged';
    const author = await parseAuthor(message.author);
    if (isProtectedSender(author.email, protectedSenders)) return 'protected_sender';
    if (protectContacts && author.email) {
        try {
            const hasPermission = await browser.permissions.contains({ permissions: ['addressBooks'] });
            if (hasPermission) {
                const contacts = await browser.contacts.quickSearch({ searchString: author.email });
                if (contacts && contacts.length > 0) return 'contact';
            }
        } catch (e) {
            console.warn('[ThunderAI | Inbox] Address book lookup failed: ' + e);
        }
    }
    return false;
}

async function findFolderByName(accountId, name, create) {
    const target = String(name || '').trim();
    if (!target) return null;
    const lower = target.toLowerCase();
    const found = (await browser.folders.query({ accountId: accountId })).filter(f => !f.isRoot && !f.isVirtual && !f.isTag && (f.name || '').toLowerCase() === lower);
    if (found.length > 0) {
        // Prefer a top level folder.
        found.sort((a, b) => (a.path || '').split('/').length - (b.path || '').split('/').length);
        return found[0];
    }
    if (!create) return null;
    const account = await browser.accounts.get(accountId, false);
    return await browser.folders.create(account.rootFolder.id, target);
}

// Resolves the destination folder of a move for a given account. Cached per call of executePlan.
async function resolveDestination(ops, accountId, cache) {
    const key = ops.move + '|' + accountId + '|' + (ops.folder_id || '') + '|' + (ops.folder_name || '');
    if (cache.has(key)) return cache.get(key);
    let dest = null;
    switch (ops.move) {
        case 'trash':
            dest = await getSpecialFolder(accountId, 'trash');
            break;
        case 'junk':
            dest = await getSpecialFolder(accountId, 'junk');
            break;
        case 'folder':
            if (ops.folder_id) dest = { id: ops.folder_id };
            else dest = await findFolderByName(accountId, ops.folder_name, true);
            break;
    }
    cache.set(key, dest);
    return dest;
}

/*
 * Executes a plan: [{ message: MessageHeader, ops }].
 * Returns { done, failed, skipped, errors, entryId }.
 */
export async function executePlan(plan, { source = 'manual', label = '', onProgress = null } = {}) {
    const records = [];
    const errors = [];
    let failed = 0;
    let processed = 0;
    const total = plan.length;
    const destCache = new Map();
    const tagsCache = { list: null };

    // 1. Property updates (per message API).
    for (const item of plan) {
        const m = item.message;
        const ops = item.ops;
        const record = {
            hmid: m.headerMessageId,
            accountId: m.folder ? m.folder.accountId : '',
            fromFolderId: m.folder ? m.folder.id : '',
            toFolderId: null,
            archived: false,
            moved: false,
            prev: { read: !!m.read, flagged: !!m.flagged, junk: !!m.junk, tags: [...(m.tags || [])] },
            changed: [],
            messageId: m.id,
            subject: m.subject || '',
            author: m.author || '',
        };
        const props = {};
        if (ops.mark_read && !m.read) { props.read = true; record.changed.push('read'); }
        if (ops.mark_unread && m.read) { props.read = false; record.changed.push('read'); }
        if (ops.flag && !m.flagged) { props.flagged = true; record.changed.push('flagged'); }
        if (ops.unflag && m.flagged) { props.flagged = false; record.changed.push('flagged'); }
        if (ops.move === 'junk' && !m.junk) { props.junk = true; record.changed.push('junk'); }
        if (ops.not_junk && m.junk) { props.junk = false; record.changed.push('junk'); }
        if (ops.tag_key && !(m.tags || []).includes(ops.tag_key)) {
            if (tagsCache.list === null) tagsCache.list = (await browser.messages.tags.list()).map(t => t.key);
            if (tagsCache.list.includes(ops.tag_key)) {
                props.tags = [...new Set([...(m.tags || []), ops.tag_key])];
                record.changed.push('tags');
            }
        }
        if (ops.untag_key && (m.tags || []).includes(ops.untag_key)) {
            props.tags = (props.tags || m.tags || []).filter(t => t !== ops.untag_key);
            if (!record.changed.includes('tags')) record.changed.push('tags');
        }
        if (Object.keys(props).length > 0) {
            try {
                await browser.messages.update(m.id, props);
            } catch (e) {
                failed++;
                errors.push((m.subject || m.id) + ': ' + e.message);
                record.changed = [];
                item.failed = true;
            }
        }
        item.record = record;
        if (!ops.move || ops.move === 'none') {
            processed++;
            if (onProgress) onProgress({ done: processed, total });
        }
    }

    // 2. Moves, grouped by destination to use one API call per group.
    const groups = new Map();
    for (const item of plan) {
        if (item.failed || !item.ops.move || item.ops.move === 'none') continue;
        const accountId = item.record.accountId;
        const groupKey = item.ops.move + '|' + accountId + '|' + (item.ops.folder_id || '') + '|' + (item.ops.folder_name || '');
        if (!groups.has(groupKey)) groups.set(groupKey, { ops: item.ops, accountId, items: [] });
        groups.get(groupKey).items.push(item);
    }
    for (const group of groups.values()) {
        const ids = [];
        let dest = null;
        try {
            if (group.ops.move !== 'archive') {
                dest = await resolveDestination(group.ops, group.accountId, destCache);
                if (!dest && group.ops.move !== 'junk') {
                    throw new Error(browser.i18n.getMessage('inbox_error_no_destination', [group.ops.move]) || ('No destination folder for ' + group.ops.move));
                }
            }
            for (const item of group.items) {
                if (dest && item.record.fromFolderId === dest.id) continue; // already there
                ids.push(item.message.id);
            }
            if (ids.length > 0) {
                if (group.ops.move === 'archive') {
                    await browser.messages.archive(ids);
                    const archives = await getSpecialFolder(group.accountId, 'archives');
                    for (const item of group.items) {
                        if (!ids.includes(item.message.id)) continue;
                        item.record.moved = true;
                        item.record.archived = true;
                        item.record.toFolderId = archives ? archives.id : null;
                    }
                } else if (dest) {
                    await browser.messages.move(ids, dest.id, { isUserAction: true });
                    for (const item of group.items) {
                        if (!ids.includes(item.message.id)) continue;
                        item.record.moved = true;
                        item.record.toFolderId = dest.id;
                    }
                }
            }
        } catch (e) {
            failed += group.items.length;
            errors.push(e.message);
            for (const item of group.items) item.failed = true;
        }
        processed += group.items.length;
        if (onProgress) onProgress({ done: processed, total });
    }

    // Partially applied changes (e.g. tag set but move failed) stay in the records so undo can revert them,
    // but only fully applied items count as done.
    let done = 0;
    for (const item of plan) {
        if (item.record && (item.record.moved || item.record.changed.length > 0)) {
            records.push(item.record);
            if (!item.failed) done++;
        }
    }
    let entryId = null;
    if (done > 0 || failed > 0) {
        entryId = await addActivity({
            source,
            label,
            count: done,
            failed,
            errors: errors.slice(0, 5),
            records,
        });
    }
    return { done, failed, errors, entryId };
}

// ---------------------------------------------------------------------------
// Activity log and undo
// ---------------------------------------------------------------------------

export async function loadActivity() {
    return (await browser.storage.local.get({ [STORAGE_ACTIVITY]: [] }))[STORAGE_ACTIVITY] || [];
}

async function saveActivity(list) {
    list = list.slice(0, ACTIVITY_MAX);
    list.forEach((entry, i) => {
        if (i >= UNDO_KEEP && entry.records) {
            entry.records = null;
            entry.undoable = false;
        }
    });
    await browser.storage.local.set({ [STORAGE_ACTIVITY]: list });
}

export async function addActivity({ source, label, count, failed = 0, errors = [], records = [] }) {
    const list = await loadActivity();
    const keepUndo = records.length <= UNDO_MAX_RECORDS;
    const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        ts: Date.now(),
        source,
        label,
        count,
        failed,
        errors,
        samples: records.slice(0, 5).map(r => r.subject),
        records: keepUndo ? records.map(({ messageId, author, ...rest }) => rest) : null,
        undoable: keepUndo && records.length > 0,
        undone: false,
    };
    list.unshift(entry);
    await saveActivity(list);
    return entry.id;
}

export async function clearActivity() {
    await browser.storage.local.remove(STORAGE_ACTIVITY);
}

async function findMessageByHmid(hmid, queryInfo) {
    const res = await browser.messages.query({ headerMessageId: hmid, ...queryInfo });
    if (res.id) await browser.messages.abortList(res.id);
    return res.messages;
}

// Undoes an activity entry. Returns { restored, missing }.
export async function undoActivity(entryId) {
    const list = await loadActivity();
    const entry = list.find(e => e.id === entryId);
    if (!entry || !entry.undoable || entry.undone || !entry.records) {
        return { restored: 0, missing: 0 };
    }
    let restored = 0;
    let missing = 0;
    // 1. Move back, grouped by original folder.
    const moveBack = new Map(); // fromFolderId -> [message ids]
    for (const r of entry.records) {
        if (!r.moved) continue;
        let candidates = [];
        if (r.toFolderId) {
            candidates = await findMessageByHmid(r.hmid, { folderId: r.toFolderId, includeSubFolders: !!r.archived });
        }
        if (candidates.length === 0) {
            candidates = (await findMessageByHmid(r.hmid, r.accountId ? { accountId: r.accountId } : {})).filter(m => !m.folder || m.folder.id !== r.fromFolderId);
        }
        if (candidates.length === 0) {
            r._missing = true;
            missing++;
            continue;
        }
        if (!moveBack.has(r.fromFolderId)) moveBack.set(r.fromFolderId, []);
        moveBack.get(r.fromFolderId).push(candidates[0].id);
    }
    for (const [folderId, ids] of moveBack.entries()) {
        try {
            await browser.messages.move(ids, folderId, { isUserAction: true });
        } catch (e) {
            console.error('[ThunderAI | Inbox] Undo move failed: ' + e.message);
        }
    }
    // 2. Restore properties in the original folder.
    for (const r of entry.records) {
        if (r._missing) continue;
        const props = {};
        if (r.changed.includes('read')) props.read = r.prev.read;
        if (r.changed.includes('flagged')) props.flagged = r.prev.flagged;
        if (r.changed.includes('junk')) props.junk = r.prev.junk;
        if (r.changed.includes('tags')) props.tags = r.prev.tags;
        if (Object.keys(props).length > 0) {
            const found = await findMessageByHmid(r.hmid, { folderId: r.fromFolderId });
            if (found.length === 0) { missing++; continue; }
            try {
                await browser.messages.update(found[0].id, props);
            } catch (e) {
                console.error('[ThunderAI | Inbox] Undo update failed: ' + e.message);
            }
        }
        restored++;
    }
    entry.undone = true;
    entry.records = null;
    entry.undoable = false;
    await saveActivity(list);
    return { restored, missing };
}
