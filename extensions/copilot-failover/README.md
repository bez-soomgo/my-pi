# copilot-failover

Model-preserving provider failover extension for [Pi](https://pi.dev).

`copilot-failover` automatically switches to a configured fallback model when the current provider hits a usage limit, rate limit, authentication failure, or transient provider error. Unlike provider-rotation extensions, it preserves the intended model whenever possible — for example, `openai-codex/gpt-5.5` falls back to `github-copilot/gpt-5.5`, and Claude Opus/Sonnet fall back to the corresponding GitHub Copilot Claude model.

> This extension was built for a Pi setup with `openai-codex`, `anthropic`, and `github-copilot` providers.

## Features

- **Model-preserving failover**
  - `openai-codex/gpt-5.5` → `github-copilot/gpt-5.5`
  - `anthropic/claude-opus-4-8` → `github-copilot/claude-opus-4.8`
  - `anthropic/claude-sonnet-4-6` → `github-copilot/claude-sonnet-4.6`
- **Automatic cooldowns** for exhausted providers.
- **Reset-time-aware recovery** using provider usage APIs where available.
- **Auto-continue** after failover so the interrupted task can resume safely.
- **Automatic restore** to the original model after its cooldown expires.
- **Manual controls** via `/failover` slash commands.
- **Persistent state** across Pi restarts.

## How it works

When an assistant response ends with a known failure pattern, the extension:

1. Detects whether the failure is a usage limit, rate limit, auth issue, or transient provider error.
2. Marks the failed provider as cooled down.
3. Uses `fallbacks` to find the next model target for the exact failed model.
4. Calls `pi.setModel(...)` to switch to the fallback.
5. Optionally sends a safe continuation prompt so the agent resumes from the last safe point.
6. Restores the original model on a later user turn once the original provider has recovered.

The extension does **not** blindly rotate through unrelated providers. It only switches through explicit `provider/modelId` fallback chains.

## Default fallback map

```text
anthropic/claude-opus-4-8    -> github-copilot/claude-opus-4.8
anthropic/claude-sonnet-4-6  -> github-copilot/claude-sonnet-4.6
openai-codex/gpt-5.5         -> github-copilot/gpt-5.5

github-copilot/claude-opus-4.8    -> anthropic/claude-opus-4-8
github-copilot/claude-sonnet-4.6  -> anthropic/claude-sonnet-4-6
github-copilot/gpt-5.5            -> openai-codex/gpt-5.5
```

Reverse mappings are included so that if Copilot is the current provider and fails, the extension can return to the native provider if it is available.

## Installation

This repository uses Pi's local extension auto-discovery.

Place the extension at:

```text
~/.pi/agent/extensions/copilot-failover/index.ts
```

Pi auto-discovers `extensions/<name>/index.ts`, so no `settings.json` package entry is required.

Then restart Pi or run:

```text
/reload
```

Verify:

```text
/failover status
```

## Recommended Pi setting

To avoid spending time retrying an already exhausted provider, set provider retries to zero:

```json
{
  "retry": {
    "provider": {
      "maxRetries": 0
    }
  }
}
```

This is recommended but not strictly required.

## Configuration

Main config file:

```text
~/.pi/agent/copilot-failover.json
```

State file:

```text
~/.pi/agent/state/copilot-failover-state.json
```

Example config:

```json
{
  "enabled": true,
  "autoContinue": true,
  "restoreOnRecover": true,
  "usageApi": {
    "enabled": true,
    "cacheTtlMs": 180000,
    "thresholdPercent": 99.5
  },
  "fallbacks": {
    "anthropic/claude-opus-4-8": ["github-copilot/claude-opus-4.8"],
    "anthropic/claude-sonnet-4-6": ["github-copilot/claude-sonnet-4.6"],
    "openai-codex/gpt-5.5": ["github-copilot/gpt-5.5"],
    "github-copilot/claude-opus-4.8": ["anthropic/claude-opus-4-8"],
    "github-copilot/claude-sonnet-4.6": ["anthropic/claude-sonnet-4-6"],
    "github-copilot/gpt-5.5": ["openai-codex/gpt-5.5"]
  },
  "cooldownMs": 21600000,
  "transientCooldownMs": 60000,
  "authCooldownMs": 60000,
  "maxAutoContinuesPerPrompt": 8,
  "continuationPrompt": "Provider failover가 발생했습니다: 이전 모델이 사용량/rate limit/인증 한계에 도달하여 {to} 로 전환했습니다. 마지막 안전한 지점부터 중단된 작업을 계속 진행하세요."
}
```

### Config fields

| Field | Description |
|---|---|
| `enabled` | Enable/disable failover. |
| `autoContinue` | Send a continuation prompt after successful failover. |
| `restoreOnRecover` | Restore the original model when its provider cooldown expires. |
| `fallbacks` | Explicit model fallback chains. Keys and values use `provider/modelId`. |
| `cooldownMs` | Default usage-limit cooldown when no reset time is available. |
| `transientCooldownMs` | Cooldown for transient provider/network failures. |
| `authCooldownMs` | Cooldown for auth failures. |
| `maxAutoContinuesPerPrompt` | Safety cap for automatic continuation loops. |
| `continuationPrompt` | Prompt sent after failover. `{to}` is replaced with the target model. |
| `usageApi.enabled` | Enable reset-time lookup for supported subscription providers. |
| `usageApi.cacheTtlMs` | Usage API cache TTL. Default is 3 minutes. |
| `usageApi.thresholdPercent` | Usage percentage treated as exhausted. Default is `99.5`. |

### Model ID notes

Model IDs differ by provider:

- Anthropic native uses hyphenated version IDs:
  - `claude-opus-4-8`
  - `claude-sonnet-4-6`
- GitHub Copilot uses dotted version IDs:
  - `claude-opus-4.8`
  - `claude-sonnet-4.6`
- OpenAI Codex uses:
  - `gpt-5.5`

If a model is not present as a key in `fallbacks`, the extension will not fail over from that model.

## Usage API and reset-aware cooldowns

For usage-limit failures, the extension tries to use reset times instead of a fixed cooldown.

### OpenAI Codex

Uses the ChatGPT Codex usage endpoint:

```text
https://chatgpt.com/backend-api/codex/usage
```

It reads the `openai-codex` OAuth credential from:

```text
~/.pi/agent/auth.json
```

Tracked windows:

- `primary` — 5-hour window
- `secondary` — 7-day window
- additional per-model limits if present

If multiple exhausted windows are active, the provider remains cooled down until the latest relevant reset time.

### Anthropic / Claude

Uses the Claude OAuth usage endpoint:

```text
https://api.anthropic.com/api/oauth/usage
```

Headers include:

```text
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/1.0.0
```

Credential lookup order:

1. `~/.pi/agent/auth.json` provider entry for `anthropic`, if present
2. `CLAUDE_CODE_OAUTH_TOKEN`
3. `~/.claude/.credentials.json`
4. macOS Keychain service `Claude Code-credentials`

Tracked windows:

- `five_hour`
- `seven_day`
- `seven_day_opus`
- `seven_day_sonnet`

> Note: this Claude usage endpoint is not an official public API. The extension caches results and falls back gracefully if the endpoint fails.

### OAuth refresh behavior

If a provider access token is expired, the extension attempts to refresh it.

For rotating refresh tokens, refreshed credentials are persisted back to their source when possible:

- `openai-codex` → `~/.pi/agent/auth.json`
- `anthropic` via Pi auth → `~/.pi/agent/auth.json`
- `anthropic` via Claude Code keychain → macOS Keychain
- `anthropic` via `~/.claude/.credentials.json` → that file

## Commands

Slash command:

```text
/failover
```

Alias:

```text
/provider-failover
```

| Command | Description |
|---|---|
| `/failover` | Same as `/failover status`. |
| `/failover status` | Show current model, cooldowns, origin restore target, and fallback map. |
| `/failover usage` | Show Codex/Claude usage using cached data when fresh. |
| `/failover usage refresh` | Force-refresh Codex/Claude usage APIs. |
| `/failover next` | Manually switch current model to its next fallback target. |
| `/failover reset` | Clear cooldowns, stopped state, and restore origin. |
| `/failover stop` | Stop auto-failover/auto-continue for the current task. |
| `/failover enable` | Enable failover in the current process. |
| `/failover disable` | Disable failover in the current process. |

## Recovery behavior

The extension restores to the original model only when safe:

- The original provider's cooldown has expired.
- `restoreOnRecover` is enabled.
- The user has not manually pinned another model with `Ctrl+P`.
- A new user turn or agent run begins.

There is no background timer that changes models while Pi is idle. Restore happens at the next request boundary to avoid surprising state changes.

## Troubleshooting

### `/failover usage` shows an Anthropic auth error

Example:

```text
anthropic: usage 조회 실패: invalid_grant
```

This usually means the Claude OAuth refresh token is expired or invalid. Re-login with Claude subscription auth:

```text
/login
```

Then select:

```text
Use a subscription -> Anthropic
```

Alternatively, refresh Claude Code's own credentials if you rely on Claude Code keychain credentials.

### `/failover usage` returns stale data

By default, usage uses cache for `usageApi.cacheTtlMs` milliseconds.

Force refresh:

```text
/failover usage refresh
```

### A model did not fail over

Check that the exact model appears as a key in `fallbacks`.

For example, this key:

```json
"anthropic/claude-opus-4-8"
```

will not match:

```text
anthropic/claude-opus-4-6
```

Add every model you want managed.

### Copilot fallback also fails

GitHub Copilot shares one account quota across GPT and Claude models. If Copilot itself is rate-limited, the extension cools down the entire `github-copilot` provider.

### Auto-continue loops too much

Lower:

```json
"maxAutoContinuesPerPrompt": 3
```

or disable auto-continue:

```json
"autoContinue": false
```

## Security and privacy

- The extension reads local OAuth credentials only to query provider usage and refresh expired tokens.
- Tokens are not logged or displayed.
- Usage API failures are summarized in state for debugging, with token values omitted.
- The Claude usage endpoint is unofficial and may change or fail without notice.

## Development

Run validation from the Pi extensions workspace:

```bash
cd ~/.pi/agent/extensions
pnpm exec tsc --noEmit --pretty false
node --experimental-strip-types --check ~/.pi/agent/extensions/copilot-failover/index.ts
```

## Status

This is a local Pi extension tailored for a setup with:

- `github-copilot`
- `openai-codex`
- `anthropic`

It is designed to be safe and explicit rather than fully automatic across all providers. Add new model pairs to `fallbacks` as needed.
