# Inbox Assistant

The Inbox Assistant lets the AI run the whole inbox: it sorts mail into categories, cleans up
by sender, finds mail waiting for a reply and sent mail nobody answered, and can sort new mail
automatically. It works across multiple accounts and folders. It needs an API integration
(any provider except ChatGPT Web); Mistral AI is proposed when the global connection is ChatGPT Web.

## Why these features (research basis)

The feature set follows what users value most in the best rated email AI tools (research done
in November 2026 on reviews and comparisons of SaneBox, Superhuman, Shortwave, Clean Email,
Inbox Zero, Gmail/Gemini, Outlook Copilot and the Thunderbird add-ons Sortana and AutoSort+):

| Users love | Tool examples | Inbox Assistant feature |
|------------|---------------|-------------------------|
| Automatic triage into a split inbox, works with the existing client | Superhuman Auto Labels/Split Inbox, SaneBox SaneLater | **Sort** tab: categories, priority, one-line summary, deadlines |
| Rules in plain words, own folders | Inbox Zero, Sortana, AutoSort+ | Custom categories described in natural language, sender rules |
| Bulk cleanup grouped by sender, one-click unsubscribe | Clean Email, Inbox Zero | **Clean up** tab: sender stats, quick wins, RFC 8058 one-click unsubscribe |
| Rules running on new mail | Clean Email Auto Clean, SaneBox | Auto-sort on `onNewMailReceived`, per-category opt-in |
| Never miss replies, follow-up reminders | Superhuman Auto Reminders, Inbox Zero Reply Zero | **Replies & follow-ups** tab with AI drafts |
| Digest of what matters | SaneBox Digest, Shortwave summaries | **Inbox brief** |

Main complaints addressed: important mail hidden by aggressive filters ("my boss's mail went to
SaneLater"), bulk deletions people regret, opaque automation and privacy concerns. Hence:
nothing is applied without confirmation unless auto-sort is enabled per category; protected
senders, contacts and flagged mail are never moved by suggested or automatic actions; every
change is logged and can be undone; trash goes to the Trash folder (never permanent delete);
only a cleaned excerpt is sent to the AI (or headers only), with the user's own API key.

## Files

| File | Role |
|------|------|
| `js/mzta-inbox-engine.js` | Categories, sender rules, triage cache, folder/message collection, digests, prompts, response parsing, AI execution (`runAIPrompt`), batch triage, brief/reply/follow-up prompts, sender statistics, List-Unsubscribe parsing |
| `js/mzta-inbox-actions.js` | Executes action plans (tag/flag/read then batched moves), protection checks, permissions per action, activity log and undo |
| `js/mzta-inbox-auto.js` | Background auto-sort queue (`taInboxAutoSort`), toolbar badge, `openInboxAssistant()` |
| `pages/inbox/mzta-inbox.html/.js/.css` | Dashboard (tabs: Sort, Clean up, Replies & follow-ups, Activity & undo) |
| `pages/inbox/mzta-inbox-settings.html/.js` | Settings: AI connection (specific integration), about you, categories editor, auto-sort, safety, sender rules, privacy/performance, sorting instructions |

Entry points: main toolbar button (`browser_action`, opens/focuses the dashboard and resets the
badge), folder pane menu "sort and clean up this folder" (`?folders=<ids>`), message list menu
"sort selected messages" (ids passed through `storage.session._inbox_selection`, `?selection=1`),
Tools menu, options page row. The menus are created in `mzta_Menus.loadInboxMenus()`, called right
after `menus.removeAll()` in `loadContextMenus()`; their ids start with `mzta-ctx-inbox-` and are
routed by `handleInboxMenuClick()` in `mzta-background.js`.

## AI connection

The hidden special prompt `prompt_inbox_triage` (`show_in: "none"`, never in menus) carries the
editable sorting instructions and the specific integration. `inbox` is in
`special_prompts_with_integration`, so `inbox_use_specific_integration` / `inbox_connection_type`
exist. `getInboxAIConfig()` resolves the connection with `getConnectionType(prefs, prompt, 'inbox')`;
`usable` is false for ChatGPT Web. All AI calls go through `runAIPrompt()`, which wraps
`mzta_specialCommand` (`json_mode` for triage and follow-ups) and always terminates the worker.
Abort and a 180 s timeout reject explicitly, because `sendPrompt()` only settles via worker messages.

## Triage

`collectMessages(scope)` — scope `{ accountIds ([] = all), folderMode: 'inbox'|'inbox_sub'|'all'|'custom', folderIds, days (0 = all), unreadOnly, maxMessages }`.
`all` excludes Trash, Junk, Drafts, Templates, Outbox, Sent and Archives. Pages are read with
`messages.query` + `continueList` (abortList at the cap), newest first.

`triageMessages(messages, { useCache, signal, onProgress })`:
1. Digest per message (`buildDigest`): sender, addressing (`to_me`/`cc_me`/other compared with the
   identities), flags, List-Unsubscribe headers and a cleaned excerpt (`htmlToText` keeps block
   boundaries and drops quoted history/hidden elements; `cleanSnippet` cuts reply headers, quoted
   lines and long links; length `inbox_snippet_length`). With `inbox_read_content = false` only headers are used.
2. Sender rules (`_inbox_sender_rules`, address or `@domain`) assign a category without AI (`source: 'rule'`).
3. Cached results (`_inbox_triage_cache`, per headerMessageId, max 3000) are reused (`source: 'cache'`).
4. The rest goes to the AI in batches of `inbox_batch_size` with `inbox_parallel_requests` concurrency.
   Emails get short ids (`1..n`); the prompt states that email content is untrusted data.
   The answer must be `{"results":[{"id","category","priority","summary","needs_reply","due","confidence"}]}`.
   `parseTriageResponse` validates ids, maps unknown categories to `other` (also by display name), clamps values.
   Emails the model skipped are retried once in a smaller batch; failures fall back to `other` with `source: 'fallback'` and the error.
   Stopping returns the partial results.

## Categories

Built-ins: `reply`, `action`, `important`, `receipt`, `newsletter`, `promotion`, `notification`, `spam`, `other`
(names/descriptions from i18n `inbox_cat_<id>` / `inbox_cat_<id>_desc`). Custom categories `custom_<n>`
need a name and a description (sent to the AI). Stored in `storage.local._inbox_categories`; `other` is
always enabled and last. Each category defines its suggested action:
`move` (`none`|`archive`|`folder`|`trash`|`junk`), `folder_id` or `folder_name` (folder with that name in
each message's account, created when missing), `tag_key`, `mark_read`, `flag`, and `auto`.

## Actions, protection and undo

`executePlan([{ message, ops }], { source, label })` applies property changes per message
(`messages.update`), then moves grouped by destination: `messages.archive`, or `messages.move(..., { isUserAction: true })`
to the folder / account Trash / account Junk (junk also sets `junk: true`). Only fully applied items count as done;
partially applied changes are still recorded so undo can revert them.
Every run is logged in `storage.local._inbox_activity` (200 entries, undo data for the newest 50,
max 3000 records each). `undoActivity(id)` finds moved messages by headerMessageId (destination folder
first, archives with subfolders, then the account), moves them back and restores read/flagged/junk/tags.

Permissions (requested from the click handler, `requestPermissionsForOps`): `messagesUpdate` for flags/tags/read/junk,
`messagesMove` for moves, `accountsFolders` to create folders by name, `messagesTags` to create tags,
`addressBooks` for contact protection. The background cannot request permissions: auto-sort checks them with
`permissions.contains` and logs a "missing permissions" activity entry instead.

Suggested/bulk-category actions and auto-sort skip protected messages (`isMessageProtected`):
`inbox_protected_senders` (address or `@domain`), address book contacts (`inbox_protect_contacts`),
flagged mail (`inbox_skip_flagged`). Manual actions on a selection are applied as requested.

## Auto-sort (background)

`newEmailListener` collects the new messages once, runs the existing `processEmails` features
(tags, spam filter, summary/translation on receive) and then `inboxAutoSort.enqueue(folder, messages, prefs_init)`
when `inbox_auto_sort` is on. Filters: only inbox folders (`inbox_auto_only_inbox`), enabled accounts
(`inbox_auto_accounts`, empty = all), not junk, not older than 3 days. The queue is flushed 5 s after
the last arrival, at most 100 messages per run. Messages are refreshed with `messages.get` (they may have
been moved by the spam filter), triaged, and the actions of categories with `auto = true` are applied
to non protected messages (`source: 'auto'`). Mail needing a reply or action increments
`_inbox_attention_count`, shown as badge on the toolbar button (`inbox_show_badge`); opening the
dashboard sends `inbox_reset_attention`.

## Clean up, follow-ups, brief, replies

- `computeSenderStats` groups messages by sender; `getUnsubscribeInfo` reads `List-Unsubscribe(-Post)`
  for the top senders. Unsubscribe: RFC 8058 one-click POST (host permission requested for that origin),
  otherwise the https page in the default browser, otherwise a prepared mailto compose window (never sent automatically).
  Quick wins: senders almost never read, read mail older than 3 months, old newsletters, mail larger than 5 MB.
- `findUnansweredSent` scans Sent folders (`inbox_followup_days`, older than 2 days) and looks for answers from
  the recipients after the sent date with a matching base subject; `classifyFollowups` asks the AI which ones expect an answer.
- `buildBriefPrompt` sends only categories, senders, subjects and summaries of relevant mail (no bodies); rendered with markdown-it (`html: false`).
- Reply/follow-up drafts (`buildReplyPrompt`) are shown in an editable dialog and handed to the existing
  `chatgpt_replyMessage` background command (follow-ups use reply all).

## Messages to the background

| Command | Purpose |
|---------|---------|
| `inbox_open` | Open or focus the dashboard (`params` optional) |
| `inbox_reset_attention` | Reset the badge counter |

## Preferences

See `options/mzta-options-default.js` (`inbox_*`) and `claude-spec/05-options.md`.
