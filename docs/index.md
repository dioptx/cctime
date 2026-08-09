---
layout: home

hero:
  name: cctime
  text: Real-time Claude Code Analytics
  tagline: Know where your time (and money) goes. Live dashboard, time breakdown, cost tracking.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/dioptx/cctime

features:
  - title: Live Dashboard
    details: Watch your session in real-time with --live. See Claude thinking, tools running, and costs accumulating as you work.
  - title: Time Insights
    details: 5-phase time breakdown — know exactly how much time Claude spends thinking vs executing tools vs waiting on you.
  - title: Cost Tracking
    details: Per-session and per-minute cost estimates for Opus, Sonnet, and Haiku. Cache hit rate visualization included.
---

## Quick Start

> **`@dioptx/cctime` is not yet published to npm.** Build from source:

```bash
git clone https://github.com/dioptx/cctime.git
cd cctime
npm install
npm run build
npm link
cctime
```

No configuration needed. cctime reads your local Claude Code session files automatically.

## Example Output

```
 cctime · 2:05pm · 12m 34s active of 18m 12s (5m 38s away)

 ── Time Breakdown ──────────────────────────────────────
 Claude thinking ████████████░░░░░░░░  3m 42s  (29%)
 Tool execution  ██████████████░░░░░░  5m 18s  (42%)
 Subagents       █████░░░░░░░░░░░░░░░  2m  5s  (17%)
 Waiting on you  ███░░░░░░░░░░░░░░░░░  1m 29s  (12%)

 ── Tokens & Cost ───────────────────────────────────────
 Tokens  ████████████████████  142.5K in 28.3K out
 Cache   ▃▄▅▆▇█████  67% hit
 Cost    ~$1.25  ($0.10/min)   Avg response: 3.2s   Turns: 8
```
