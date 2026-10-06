# Compaction: custom instructions are dropped for split turns

**Package:** `@earendil-works/pi-coding-agent` 0.99.2 (`dist/core/compaction/compaction.js`)
**Repo:** https://github.com/earendil-works/pi (packages/coding-agent)

## What happens

When compaction cuts inside a turn, `compact()` builds the summary from two parts: the earlier
history and the prefix of the split turn. Custom instructions only reach the first part.

```js
if (isSplitTurn && turnPrefixMessages.length > 0) {
    let historyText = previousSummary ?? "No prior history.";
    if (messagesToSummarize.length > 0) {
        // customInstructions passed here
        const historyResult = await generateSummaryWithUsage(..., customInstructions, ...);
        historyText = historyResult.text;
    }
    // ...but generateTurnPrefixSummary has no customInstructions parameter
    const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, ...);
```

So:

- With earlier history, the instructions guide the history summary but not the turn prefix.
- With no earlier history (`messagesToSummarize` is empty), the instructions reach no model
  call at all. The summary starts with "No prior history." and the turn prefix is summarized
  with the generic `TURN_PREFIX_SUMMARIZATION_PROMPT` only.

The caller gets no hint that its instructions were ignored.

## How we hit it

We run resident agents through the SDK (pi-dock). One agent did a single long task, a
read-only review that read several files, then asked a second agent to compact it via pi-link's
`link_compact`, with instructions to preserve the review findings. pi-link and `ctx.compact`
forward the instructions correctly. Compaction used `keepRecentTokens: 4000`, so the cut fell
inside the only turn.

The stored summary began with "No prior history." followed by a "Turn Context (split turn)"
section. Nothing in it reflected the instructions. Reading the code above explains why: there
was no history to summarize, so the instructions were never sent.

A low `keepRecentTokens` makes this easy to reach, but it doesn't depend on it: any session
whose kept tail starts inside a long first turn behaves the same with the default setting.

## Expected

Custom instructions should guide every summarization call that a compaction makes, including
the turn-prefix one. Passing `customInstructions` to `generateTurnPrefixSummary` and appending
them to its prompt, the way `generateSummaryWithUsage` does, would be enough.

## Impact

Anyone who compacts with instructions (`/compact <text>`, `ctx.compact({ customInstructions })`,
or tools built on them) can silently lose their focus exactly when a turn is split, which is
also when the most recent work is being summarized.
