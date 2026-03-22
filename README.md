# claude-codex-bridge-feishu

Feishu-native bridge for Claude, Codex, and compatible CLI/SDK runners.

This repository contains the Feishu transport, request queue, approval flow, runner adapters, and operational helpers extracted from a live bridge setup, without runtime secrets, host-specific state, or deployment-specific memory files.

## What Is Included

- Feishu webhook transport and message routing
- Request queue and persistent conversation state
- Approval flow with text fallback and Feishu card buttons
- Claude SDK runner integration
- Codex runner integration
- Optional Gemini readonly classifier for Claude Bash approvals
- Minimal start/status/stop scripts for instance-based runtime
- Node tests for bridge event handling, card payloads, and request execution behavior

## What Is Not Included

- live app credentials
- instance env files with secrets
- runtime logs and state under `data/`
- project-local Codex or Claude home directories
- host-specific memory files and local development instructions

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create an instance env:

```bash
cp .env.example instances/claude.env
```

3. Fill in at least:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BRIDGE_RUNNER`
- `BRIDGE_DEFAULT_CWD`

4. Start the bridge:

```bash
./scripts/start-instance.sh claude
```

5. Check status:

```bash
./scripts/status-instance.sh claude
```

## Approval Behavior

- clear readonly Bash commands can be auto-approved by rules
- uncertain readonly Bash commands can optionally be classified by Gemini
- everything else falls back to explicit approval

The Gemini classifier is disabled by default. Enable it through the `BRIDGE_CLAUDE_GEMINI_*` env vars in `.env.example`.

## Repository Layout

```text
src/
  app/
  approval/
  ops/
  requests/
  runner/
  store/
  transport/
  util/
test/
scripts/
instances/
```

## Notes

- `scripts/start-instance.sh` expects `instances/<instance>.env`
- the bridge runtime stores state in `data/<instance>/store.json`
- Feishu callback routing is external to this repo; you still need to point your public webhook URL at the running process
