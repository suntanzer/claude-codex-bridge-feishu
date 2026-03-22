# Claude Audit Summary

## Scope

- Repository: `claude-codex-bridge-feishu`
- Branch: `main`
- Reviewed local commit: `8b4d046`
- Intended use: handoff summary for an external Claude audit of the public GitHub repo contents

## High-Level Shape

This repo is a sanitized extraction of the Feishu bridge from a live internal setup. The main runtime path is:

- Feishu webhook ingress and callback handling
- request queue and persisted conversation state
- approval store and approval UI
- runner factory for Claude SDK, Codex, and tmux-backed runners
- Feishu rich-text and card rendering

Key entry points:

- [`src/app/main.mjs`](/home/jetR/claude-codex-bridge-feishu/src/app/main.mjs)
- [`src/app/feishu-event-handler.mjs`](/home/jetR/claude-codex-bridge-feishu/src/app/feishu-event-handler.mjs)
- [`src/app/request-executor.mjs`](/home/jetR/claude-codex-bridge-feishu/src/app/request-executor.mjs)
- [`src/transport/feishu-client.mjs`](/home/jetR/claude-codex-bridge-feishu/src/transport/feishu-client.mjs)
- [`src/transport/feishu-cards.mjs`](/home/jetR/claude-codex-bridge-feishu/src/transport/feishu-cards.mjs)
- [`src/runner/factory.mjs`](/home/jetR/claude-codex-bridge-feishu/src/runner/factory.mjs)

## Sanitization Checks Already Performed

- Removed runtime state directories such as `data/`
- Removed local instance env files with secrets
- Removed local memory files and host-specific notes
- Rewrote [`README.md`](/home/jetR/claude-codex-bridge-feishu/README.md), [`.env.example`](/home/jetR/claude-codex-bridge-feishu/.env.example), and [`instances/common.env.example`](/home/jetR/claude-codex-bridge-feishu/instances/common.env.example) to use placeholders instead of live values
- Added [`.gitignore`](/home/jetR/claude-codex-bridge-feishu/.gitignore) to exclude env files, runtime data, local homes, and backups
- Removed backup files copied over during extraction
- Grep scan over the tracked working tree found no live matches for:
  - local usernames
  - known hostnames and domains
  - live Feishu app ID and app secret
  - Gemini API keys
  - local absolute runtime paths

Validation performed:

- `npm run check`
- `npm test`

## Important Audit Focus Areas

### 1. Public metadata is not fully neutral

The tracked files are sanitized, but the first public commit was pushed with a host-derived author identity. That is not in the working tree, but it is visible in Git history on GitHub.

Audit question:

- Is the current public Git metadata acceptable, or should history be rewritten before wider sharing?

### 2. Scope is broader than the repo name suggests

Although the repo is Feishu-focused, it still includes non-Feishu or legacy pieces:

- [`src/transport/mattermost-client.mjs`](/home/jetR/claude-codex-bridge-feishu/src/transport/mattermost-client.mjs)
- [`src/transport/routing.mjs`](/home/jetR/claude-codex-bridge-feishu/src/transport/routing.mjs)
- [`src/runner/kimi.mjs`](/home/jetR/claude-codex-bridge-feishu/src/runner/kimi.mjs)
- [`src/runner/codex-tmux.mjs`](/home/jetR/claude-codex-bridge-feishu/src/runner/codex-tmux.mjs)
- [`src/runner/claude-tmux.mjs`](/home/jetR/claude-codex-bridge-feishu/src/runner/claude-tmux.mjs)

Audit question:

- Are these intentionally retained as reusable bridge infrastructure, or should the public repo be narrowed to Feishu-only paths?

### 3. Feishu group threading is root-message based, not true `thread_id` based

Current group routing derives conversation identity from `root_id / parent_id / message_id`, not from a persisted Feishu `thread_id`:

- [`src/transport/feishu-routing.mjs`](/home/jetR/claude-codex-bridge-feishu/src/transport/feishu-routing.mjs)

Audit question:

- Is this conversation model sufficient, or should the design move to explicit Feishu thread identifiers for correctness?

### 4. Approval buttons intentionally use legacy card structure

Normal rich cards use schema `2.0`, but approval/checkpoint cards use the older `elements` layout because Feishu schema `2.0` rejects `action` buttons:

- [`src/transport/feishu-cards.mjs`](/home/jetR/claude-codex-bridge-feishu/src/transport/feishu-cards.mjs)
- [`src/app/feishu-event-handler.mjs`](/home/jetR/claude-codex-bridge-feishu/src/app/feishu-event-handler.mjs)

Audit question:

- Is the mixed card-schema approach acceptable long term, or should approval UX be redesigned around current Feishu card capabilities?

### 5. Webhook logging is intentionally narrow, but should be reviewed

The webhook server logs remote address, user-agent, encryption presence, payload type, and event type. It does not log raw message bodies:

- [`src/transport/feishu-webhook-server.mjs`](/home/jetR/claude-codex-bridge-feishu/src/transport/feishu-webhook-server.mjs)

Audit question:

- Is this log surface appropriate for production, or should even this metadata be reduced or made configurable?

### 6. Claude readonly auto-approval is a two-stage policy surface

Readonly auto-approval for Claude Bash tool calls is split across:

- rules in [`src/runner/claude-bash-readonly.mjs`](/home/jetR/claude-codex-bridge-feishu/src/runner/claude-bash-readonly.mjs)
- Gemini fallback in [`src/runner/gemini-readonly.mjs`](/home/jetR/claude-codex-bridge-feishu/src/runner/gemini-readonly.mjs)

Audit question:

- Are the readonly heuristics conservative enough, and are the Gemini prompt, threshold, and failure semantics safe?

### 7. Runtime prerequisites are partly outside npm dependencies

`package.json` only declares the Claude SDK package. Other runner modes rely on external binaries, tmux sessions, or external ingress:

- [`package.json`](/home/jetR/claude-codex-bridge-feishu/package.json)
- [`src/runner/factory.mjs`](/home/jetR/claude-codex-bridge-feishu/src/runner/factory.mjs)
- [`README.md`](/home/jetR/claude-codex-bridge-feishu/README.md)

Audit question:

- Is the current documentation explicit enough about required external binaries, Feishu app configuration, and ingress setup?

## Suggested Claude Audit Prompts

Use these as the first pass:

1. Review this repo for any remaining secret exposure, host leakage, or unsafe public metadata assumptions.
2. Review the Feishu transport, approval flow, and request executor for correctness, duplication risk, and race conditions.
3. Review whether the public repo scope is coherent, or whether legacy Mattermost/tmux/Kimi pieces should be split out or removed.

## Expected Audit Output

The most useful output from Claude would be:

- concrete findings with file references
- any remaining public-sanitization risks
- protocol or API mismatches with Feishu
- concurrency or retry issues in webhook and queue handling
- documentation gaps that would confuse an external adopter
