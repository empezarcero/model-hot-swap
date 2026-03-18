# model-hot-swap

An [OpenCode](https://opencode.ai) plugin that automatically switches to the next model in your fallback chain when a provider hits rate limits, goes down, or returns errors. Zero manual intervention.

## How it works

1. The plugin discovers all models connected in your OpenCode config
2. You pick which models to include and their priority order
3. When the active provider returns a 429, 5xx, auth error, or output-length error, the plugin calls `config.update({ model })` to swap to the next available model
4. A per-provider circuit breaker tracks failures — after N consecutive failures, the provider is put on cooldown
5. If all providers are cooling down, the one expiring soonest is selected

No proxy, no middleware. It's a native OpenCode plugin that subscribes to `session.error` events.

## Install

### Quick install (agent-friendly)

Feed the install guide to your agent:

```bash
curl -fsSL https://raw.githubusercontent.com/empezarcero/model-hot-swap/main/INSTALL.md
```

### Manual install

```bash
git clone https://github.com/empezarcero/model-hot-swap.git
cd model-hot-swap
bun install
```

Register the plugin in your project's `opencode.json`:

```json
{
  "plugin": ["file:///absolute/path/to/model-hot-swap/src/index.ts"]
}
```

Start OpenCode and run `/hotswap` to configure your fallback chain.

## Tools

The plugin registers two tools that agents can call:

| Tool | Description |
|------|-------------|
| `hot_swap_config` | Discover connected models, view current config, or set the fallback chain. When called without arguments, presents a multi-select checklist for the user to pick models. |
| `hot_swap_status` | Show the active model, per-provider failure counts, and cooldown timers. |

## Slash command

| Command | Description |
|---------|-------------|
| `/hotswap` | Triggers the agent to run the config flow — discover models, present a checklist, save selection. |

## Configuration

The plugin persists its config to `hot-swap.json` in your project root:

```json
{
  "models": [
    "anthropic/claude-sonnet-4-20250514",
    "openai/gpt-4o",
    "google/gemini-2.5-pro"
  ],
  "cooldown": 300000,
  "maxFailures": 3
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `models` | `string[]` | `[]` | Ordered fallback chain — first model is highest priority |
| `cooldown` | `number` | `300000` | Milliseconds before retrying a failed provider (default 5 min) |
| `maxFailures` | `number` | `3` | Consecutive failures before a provider enters cooldown |

## Error detection

The plugin swaps on these error types:

- **429** — Rate limit
- **5xx** — Server errors
- **Retryable API errors** — As flagged by the SDK
- **Provider auth errors** — Bad key, expired token
- **Output length exceeded** — Model hit max output tokens
- **Pattern match** — Error messages containing `rate limit`, `too many requests`, `exhausted`, `unavailable`, `overloaded`

User-initiated aborts (`MessageAbortedError`) are ignored.

## Requirements

- [OpenCode](https://opencode.ai) with plugin support
- [Bun](https://bun.sh) runtime
- At least 2 model providers configured

## License

MIT
