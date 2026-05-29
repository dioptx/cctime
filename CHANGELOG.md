# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Token breakdown: decompose the "in" headline into fresh vs cached.** The headline
  "NN in" is dominated by cheap `cache_read` tokens; a new `Input  X new · Y cached`
  line separates freshly-billed input (`input + cache_creation`) from cache reads, so the
  cost line is interpretable (a big "in" at 97% cache is mostly $1.50/M reads, not $15/M
  fresh input). Applied to the single-session and live views.

### Fixed

- **Token dedup: fall back to `message.id` when `requestId` is absent.** Streaming
  assistant chunks share a `requestId` and `deduplicateAssistant` collapses them so
  their (identical) usage is counted once — without it, tokens inflate ~2-3×. But
  assistant rows that *omit* `requestId` (older Claude Code versions / partial logs)
  bypassed the grouping entirely and re-introduced that inflation. They still share
  `message.id`, so dedup now keys on `requestId ?? message.id`. Rows with neither key
  pass through unchanged.

## [1.0.0] - 2026-02-18

### Added

- **Live dashboard** (`--live`): Real-time session monitoring with auto-refresh
- **5-phase time breakdown**: Claude thinking, tool execution, subagents, planning, waiting on you
- **Cost tracking**: Per-session and per-minute cost estimates for Opus, Sonnet, and Haiku
- **Tool latencies**: Per-tool avg/p50/p95 response times
- **Token deduplication**: Accurate token counts by merging streaming chunks
- **Cache hit rate**: Visual bar showing prompt cache efficiency
- **Context trend**: Sparkline showing input context growth over session
- **Hourly activity heatmap**: 24-hour sparkline in aggregate views
- **Daily breakdown**: Per-day stats with bars for multi-day views
- **Session filtering**: `--since`, `--until`, `--model`, `--min-duration`, `--min-cost`
- **Session lookup**: `--session <id>` to target a specific session
- **Sort options**: `--sort cost|duration|tokens|turns|time`
- **Export formats**: `--csv`, `--markdown`, `--compact`, `--json` (with aggregate envelope)
- **Project filtering**: `--project <path>` to scope to a specific project
- **Color control**: `--no-color` and `--color` flags
- **Better error messages**: Actionable hints for empty results and filter mismatches
