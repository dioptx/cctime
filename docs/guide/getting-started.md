# Getting Started

## Install

> **`@dioptx/cctime` is not yet published to npm.** Build from source until the package is available on the registry.

```bash
git clone https://github.com/dioptx/cctime.git
cd cctime
npm install
npm run build
npm link          # makes the `cctime` command available globally
```

To update later: `git pull && npm install && npm run build`.

### From npm (once published)

```bash
# Run directly (no install)
npx @dioptx/cctime

# Or install globally
npm install -g @dioptx/cctime
```

## Requirements

- **Node.js 18+**
- **Claude Code** installed and used (creates session files at `~/.claude/projects/`)

## First Run

After using Claude Code at least once, run:

```bash
cctime
```

This shows your most recent session with a full time breakdown, token usage, cost estimate, and tool latencies.

## Common Commands

```bash
cctime                    # Last session
cctime --all              # All sessions today
cctime --week             # Weekly rollup
cctime --live             # Live dashboard
cctime --week --sort cost # Sort by cost
```

## What You'll See

cctime breaks every session into 5 phases:

1. **Claude thinking** — the model is generating a response
2. **Tool execution** — running Bash, Read, Edit, Grep, etc.
3. **Subagents** — Task agents running in parallel
4. **Planning** — plan mode is active
5. **Waiting on you** — you're reading or typing (< 2 min)

Time away (gaps > 2 minutes) is tracked separately and excluded from "active time."
