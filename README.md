# pi-context

A `/context` command for [pi](https://github.com/earendil-works/pi-coding-agent) — like Claude Code's `/context`, but for pi.

pi's footer shows *one* aggregate token number. `pi-context` breaks that number down so you can see **what is actually consuming your context window**:

- **Tool schemas**, grouped by the extension/package that registered them (usually the #1 consumer)
- **System prompt** text (base prompt + guidelines + tool one-liners + pi docs)
- **Context files** (`AGENTS.md` / `CLAUDE.md`)
- **Skills** listing
- **Conversation** (messages)

The report renders inline in the transcript and is **never sent to the LLM**, so running it costs you nothing.

## Example

```
/context  31,507 tokens  · 15.8% of 200.0k
github-copilot/claude-opus-4.8  ·  calibrated to measured total

TOOL SCHEMAS                     26,015
  pi-background-tasks       11   7,480 ████████████  24%
  pi-hermes-memory           6   5,929 █████████░░░  19%
  pi-web-access              4   4,198 ██████░░░░░░  13%
  ...
SYSTEM PROMPT                     4,192
  base + guidelines + docs         2,232 ███░░░░░░░░░   7%
  context files (AGENTS.md)        1,107 █░░░░░░░░░░░   4%
  skills listing                     853 █░░░░░░░░░░░   3%
CONVERSATION                      1,300
  messages                         1,300 █░░░░░░░░░░░   4%
──────────────────────────────────────────────────────────
TOTAL                            31,507  15.8% of window
```

Expand the entry (in the transcript) to see a **per-tool** breakdown inside each group.

## Install

```bash
pi install git:github.com/ericboehs/pi-context
```

Then run `/context` in any session. Update later with:

```bash
pi update git:github.com/ericboehs/pi-context
```

Or load it locally for a quick try without installing:

```bash
pi -e /path/to/pi-context/index.ts
```

## How token counts are computed

pi-context uses a fast, dependency-free **local estimator** (characters ÷ a per-token divisor: prose ≈ 4.0, JSON schemas ≈ 3.4). When pi has a measured context total available (`ctx.getContextUsage()`), every section is **calibrated** so the per-section numbers reconcile exactly to that measured total. Before the first model response in a session, it falls back to a pure estimate (labeled as such).

Tune the divisors if you like:

```bash
PI_CONTEXT_CPT_PROSE=4.0 PI_CONTEXT_CPT_JSON=3.4 pi
```

Only **active** tools are counted (the ones actually sent to the model), so disabling tools with `--exclude-tools` / `--tools` is reflected immediately.

## Why this is useful

Extensions are convenient, but each one ships tool schemas that live in *every* request. It's easy to accumulate 20–30 tools and quietly spend 25k+ tokens of context before you type anything. `/context` shows you exactly which extensions cost the most, so you can decide what to keep, trim (`--exclude-tools`), or uninstall.

## License

MIT
