# Installing model-hot-swap

This plugin automatically switches models when a provider hits rate limits or goes down.

## Prerequisites

- [OpenCode](https://opencode.ai) installed and working
- [Bun](https://bun.sh) runtime installed
- At least 2 model providers configured in OpenCode (e.g. Anthropic + OpenAI)

## Step 1: Clone and install

```bash
git clone https://github.com/empezarcero/model-hot-swap.git
cd model-hot-swap
bun install
```

## Step 2: Register the plugin

Add the plugin to your project's `opencode.json` (create it if it doesn't exist):

```json
{
  "plugin": ["file:///absolute/path/to/model-hot-swap/src/index.ts"]
}
```

Replace `/absolute/path/to` with the actual path where you cloned the repo.

Alternatively, copy the source into your project's plugin directory:

```bash
mkdir -p .opencode/plugins
cp /path/to/model-hot-swap/src/index.ts .opencode/plugins/hot-swap.ts
```

If using the `.opencode/plugins/` method, install the dependencies in your project:

```bash
bun add @opencode-ai/plugin @opencode-ai/sdk
```

## Step 3: Configure your fallback chain

Start OpenCode. The plugin auto-discovers all connected models.

**Option A — Slash command (recommended):**

Type `/hotswap` in the chat. The agent will discover available models, present a multi-select checklist, and save your selection.

**Option B — Ask the agent directly:**

> "Configure hot-swap with anthropic/claude-sonnet-4-20250514, openai/gpt-4o, and google/gemini-2.5-pro"

**Option C — Manual config:**

Create `hot-swap.json` in your project root:

```json
{
  "models": [
    "anthropic/claude-sonnet-4-20250514",
    "openai/gpt-4o"
  ],
  "cooldown": 300000,
  "maxFailures": 3
}
```

- **cooldown** — milliseconds before retrying a failed provider (default: 300000 = 5 min)
- **maxFailures** — consecutive failures before cooldown (default: 3)

## Step 4: Verify

Restart OpenCode. Check `/tmp/hot-swap-debug.log` for:

```
[hot-swap] discovered N connected models
[hot-swap] fallback chain: anthropic/claude-sonnet-4-20250514 → openai/gpt-4o
```

## Available tools

| Tool | Description |
|------|-------------|
| `hot_swap_config` | List connected models, view current config, or set the fallback chain |
| `hot_swap_status` | Show active model, failure counts, and cooldown timers |

## Agent instructions

If you are an AI agent installing this plugin:

1. Clone the repo to a known location and run `bun install`
2. Get the absolute path to `src/index.ts` in the cloned directory
3. Add `"file:///that/absolute/path/src/index.ts"` to the project's `opencode.json` plugin array
4. Restart OpenCode
5. Use `/hotswap` or call `hot_swap_config` to discover models
6. Present the discovered models to the user as a multi-select checklist using the question tool
7. Call `hot_swap_config` with the selected models as a comma-separated string
8. Verify by calling `hot_swap_status`
