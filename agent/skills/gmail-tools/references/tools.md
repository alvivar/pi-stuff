# Bundled Gmail CLI contract

All executable code lives in this skill's scripts/. There is no extension,
registered tool, package registration, settings entry or API/OAuth dependency.
Invoke each operation through bash:
`node "<absolute skill dir>/scripts/gmail.mjs" COMMAND [--session NAME] [--confirm DIGEST]`
Read parameters from stdin as one JSON object; stdout is one JSON result.
Errors return exit 1. Output is bounded to 48KB; there is no raw-output dump file.

## Operations

### connect
`{"account":string,"tab_id"?:string}`
Returns verified account, existing tab ID and Gmail account path. It never opens
a tab or accepts consent. Chrome remote-debugging approval is the user's action.

### scan
`{"query":string,"limit"?:1..100,"page"?:1..100,"offset"?:0..99,"page_token"?:string,"max_pages"?:1..10,"include_snippets"?:boolean}`
Default limit 50 and max_pages 5. Returns batch_id, count, immutable numbered
conversation metadata and next_page (cursor or null). Metadata:
`n,ref,sender,subject,time,unread,labels`; ref is a stable legacy thread ID.
One conversation may contain several messages. Subjects/snippets redact likely
codes/references. Stored metadata retains a subject fingerprint, not raw numeric
subject codes or snippets.

Continue pagination with the same query and cursor fields, without intervening
mailbox mutations. After mutations restart from page 1. Cursor fingerprints
detect changed offset pages.

### inspect
`{"batch_id":string,"n":1..100,"allow_mark_read"?:boolean,"max_chars"?:1..12000,"redact_sensitive"?:boolean}`
Defaults: allow_mark_read false, max_chars 6000, redact_sensitive true.
Returns visible conversation text and attachment names without downloads.
Reports marked_read, truncated and untrusted_email_content.
Hidden/collapsed message bodies are not expanded automatically.
The body is not saved in local script state, but normal shell output enters
Pi tool history. Redaction is best-effort, not a guarantee.

### prepare
`{"batch_id":string,"changes":[{"n":integer,"add_labels"?:string[],"remove_labels"?:string[],"read"?:boolean,"destination"?:string}]}`
Destinations: archive, inbox, trash, not_spam. Supply 1..100 unique numbers.
Omitted numbers are untouched. Empty changes, conflicting label edits and
system-label edits are rejected. Existing custom labels only; no label creation.
Return: plan_id, digest, numbered operations and already_satisfied flags.
No email is modified during preparation.

Example of mechanical operations; the caller chooses the labels and numbers:
```json
{"batch_id":"<returned ID>","changes":[
  {"n":2,"read":true,"destination":"archive"},
  {"n":7,"add_labels":["<existing label requested by user>"]},
  {"n":11,"destination":"trash"}
]}
```
not_spam is a no-op outside Spam; inbox explicitly unarchives normal mail.
Spam/Trash cannot be implicitly rescued with archive/inbox.

### apply
Stdin: `{"plan_id":string,"digest":string}`
Required CLI flag: `--confirm <same exact digest>`.
The caller must obtain the authorization required by the conversation before
passing the flag. It prevents accidental/mismatched execution, but does not
authenticate a human. There is **no Pi UI dialog** in this pure-script version.

A plan can be attempted once. States: prepared, running, completed, partial,
uncertain. A mismatched/missing flag causes zero mutation and leaves it prepared.
Account, identity, revision, selection and state are checked before clicks.
Results include a bounded journal. Mutations are not atomic; some steps can
complete before an error. Never blindly replay. Allow up to 10 minutes.

### verify
`{"plan_id":string}`
Read-only lookup including archived/Spam/Trash mail. Reports actual vs expected
states per number. It neither repairs errors nor authorizes retries and does
not imply that external/security problems were resolved.

### batch
`{"id":string,"from"?:1..100,"limit"?:1..100,"forget"?:boolean}`
Retrieve a stored batch/plan or forget active metadata only. Never deletes email
or edits Pi tool history. Forget dependent plans first. At most 20 batches and
20 plans per script session. No organization preferences are stored.

## Local state and locking

The default scope comes from PI_SESSION_ID, which Pi injects into shell tools.
Outside Pi use --session explicitly. There is no implicit shared fallback.
State is in <skill>/.state/<SHA256(scope)>.json, with a matching .lock directory.
Writes are atomic; metadata has private file modes where supported. On Windows
it inherits the user's folder ACL. Do not copy/share .state/ with the skill.

State survives compaction/reload but is not Pi-branch-relative. Navigating the
Pi tree does not rewind script state or Gmail. New session IDs isolate state.
A prior running status is recovered as uncertain. No automatic mutation retry.

The browser lane lock is:
~/.config/browser-harness/tmp/pi-gmail-tools.lock/owner.json
Both lock types contain owner PID/time, not bodies. A crash may leave a lock:
inspect its PID and remove only a confirmed stale lock. Locks are not stolen.
A browser failure with an unknown outcome deliberately keeps the browser lane
lock, because commands already sent to the browser-use daemon outlive the CLI:
errors `interrupted` (cancel/timeout), `no_response` (worker exit without a complete
result), `browser_error`, `apply_interrupted` and `dom_operation_failed`
(unexpected exceptions, including daemon IPC timeouts). Other error codes are
completed determinations and release it. Confirm the Gmail tab is idle, remove the lock,
then verify before any new change.

## Limits and boundary

English Gmail UI, Node.js 22.19+, browser-use on PATH, local signed-in Chrome.
Action lookups examine up to 20 search pages. No Pi/npm dependencies to install.
No sending/replies, permanent deletion, link following, attachment downloads,
subscription changes, account settings, API credentials or infrastructure changes.
Telemetry must be disabled with null install_id; otherwise scripts stop.
Recording is disabled for these operations. No Browser Use Cloud: BU_AUTOSPAWN
is set empty, so browser-use cannot bootstrap a cloud browser. Callers must ensure
the default daemon is local: an already running non-local default daemon is not
detected (vendor-cloud daemons are forbidden by the browser-use policy). A non-default
BU_NAME, BU_CDP_URL and BU_CDP_WS are refused here.
Other browser controllers/human navigation can still race the UI: serialize work.
