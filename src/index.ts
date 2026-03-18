import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { Event, EventSessionError, ApiError, Config as SdkConfig } from "@opencode-ai/sdk"
import { readFileSync, writeFileSync, appendFileSync } from "node:fs"

const DEBUG_LOG = "/tmp/hot-swap-debug.log"

type Config = {
  models: string[]
  cooldown: number
  maxFailures: number
}

type State = {
  failures: number
  cooldownUntil: number
}

const DEFAULTS: Config = {
  models: [],
  cooldown: 300_000,
  maxFailures: 3,
}

function log(msg: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] [hot-swap] ${msg}\n`
  try { appendFileSync(DEBUG_LOG, line) } catch {}
}

function cfgpath(dir: string) {
  return `${dir}/hot-swap.json`
}

function load(dir: string): Config {
  try {
    const raw = JSON.parse(readFileSync(cfgpath(dir), "utf-8"))
    return {
      models: Array.isArray(raw.models) ? raw.models : DEFAULTS.models,
      cooldown: typeof raw.cooldown === "number" ? Math.max(0, raw.cooldown) : DEFAULTS.cooldown,
      maxFailures: typeof raw.maxFailures === "number" ? Math.max(1, raw.maxFailures) : DEFAULTS.maxFailures,
    }
  } catch {
    return DEFAULTS
  }
}

function save(dir: string, cfg: Config) {
  writeFileSync(cfgpath(dir), JSON.stringify(cfg, null, 2) + "\n", "utf-8")
  log(`saved config to ${cfgpath(dir)}`)
}

// Provider ID extraction — circuit breaker is keyed by provider, so all models
// from the same provider share cooldown state (intentional: provider-level outages
// affect all its models).
function pid(model: string): string {
  return model.split("/")[0]
}

function isError(event: Event): event is EventSessionError {
  return event.type === "session.error"
}

function isSwappable(err: EventSessionError["properties"]["error"]): boolean {
  if (!err) return false
  // User-initiated abort — not a provider issue
  if (err.name === "MessageAbortedError") return false
  // Output length exceeded — try a different model
  if (err.name === "MessageOutputLengthError") return true
  if (err.name === "APIError") {
    const code = (err as ApiError).data.statusCode
    return code === 429 || (code !== undefined && code >= 500 && code < 600) || (err as ApiError).data.isRetryable
  }
  if (err.name === "ProviderAuthError") return true
  if (err.name === "UnknownError") {
    const msg = err.data.message ?? ""
    return /rate.?limit|too.?many.?requests|exhausted|unavailable|overloaded/i.test(msg)
  }
  return false
}

async function discover(ctx: PluginInput): Promise<string[]> {
  try {
    const res = await ctx.client.provider.list()
    if (!res.data) {
      log("discover: no data in provider.list response")
      return []
    }

    const data = res.data
    log(`discover: ${data.all?.length ?? 0} providers, connected: [${data.connected?.join(", ")}]`)

    if (data.all) {
      for (const p of data.all) {
        const modelKeys = Object.keys(p.models ?? {})
        if (data.connected?.includes(p.id)) {
          log(`discover: ${p.id} — ${modelKeys.length} models (connected)`)
        }
      }
    }

    const connected = new Set(data.connected)
    const models: string[] = []
    if (!data.all) {
      log("discover: data.all is missing")
      return []
    }
    for (const p of data.all) {
      if (!connected.has(p.id)) continue
      for (const key of Object.keys(p.models)) {
        const m = p.models[key] as any
        const tc = m.tool_call ?? m.capabilities?.toolcall
        if (tc) models.push(`${p.id}/${m.id}`)
      }
    }
    log(`discover: found ${models.length} tool-capable models from ${connected.size} connected providers`)

    if (!models.length && connected.size > 0) {
      log("discover: tool_call info missing — including all connected models")
      for (const p of data.all) {
        if (!connected.has(p.id)) continue
        for (const key of Object.keys(p.models)) {
          models.push(`${p.id}/${p.models[key].id}`)
        }
      }
    }
    return models.sort()
  } catch (e) {
    log(`failed to discover models: ${e}`)
    log(`discover error stack: ${e instanceof Error ? e.stack : "no stack"}`)
    return []
  }
}

export const HotSwap: Plugin = async (ctx: PluginInput) => {
  log("plugin init")
  const dir = ctx.directory
  let cfg = load(dir)

  if (cfg.models.length) {
    log(`fallback chain: ${cfg.models.join(" → ")}`)
  }

  const circuit = new Map<string, State>()
  let active = 0

  function get(id: string): State {
    if (!circuit.has(id)) circuit.set(id, { failures: 0, cooldownUntil: 0 })
    return circuit.get(id)!
  }

  function next(): number | undefined {
    const now = Date.now()
    for (let i = 0; i < cfg.models.length; i++) {
      const idx = (active + 1 + i) % cfg.models.length
      if (idx === active) continue
      const s = get(pid(cfg.models[idx]))
      if (s.cooldownUntil <= now) return idx
    }
    let best: number | undefined
    let earliest = Infinity
    for (let i = 0; i < cfg.models.length; i++) {
      if (i === active) continue
      const s = get(pid(cfg.models[i]))
      if (s.cooldownUntil < earliest) {
        earliest = s.cooldownUntil
        best = i
      }
    }
    return best
  }

  async function swap(reason: string) {
    if (!cfg.models.length) return
    if (active >= cfg.models.length) active = 0
    const id = pid(cfg.models[active])
    const s = get(id)
    s.failures++

    if (s.failures >= cfg.maxFailures) {
      s.cooldownUntil = Date.now() + cfg.cooldown
      log(`${id} hit ${cfg.maxFailures} failures — cooling down for ${cfg.cooldown / 1000}s`)
    }

    const target = next()
    if (target === undefined) {
      log(`no alternative providers available — staying on ${cfg.models[active]}`)
      return
    }

    active = target
    const model = cfg.models[active]
    log(`switching to ${model} (reason: ${reason})`)

    try {
      await ctx.client.config.update({ body: { model } })
      log(`active model set to ${model}`)
    } catch (e) {
      log(`failed to update config: ${e}`)
    }
  }

  return {
    async config(input: SdkConfig) {
      if (!input.command) input.command = {}
      input.command["hotswap"] = {
        template:
          "Use the hot_swap_config tool to configure the model hot-swap fallback chain. " +
          "First call it with no arguments to discover available models, then present them " +
          "to the user using the question tool with multiple=true so they can select from a checklist, " +
          "then call hot_swap_config again with the selected models as a comma-separated string.",
        description: "Configure model hot-swap fallback chain",
      }
      log("registered /hotswap command")
    },

    tool: {
      hot_swap_config: tool({
        description:
          "Configure the model hot-swap fallback chain. " +
          "Lists all connected models and lets you select which ones to include. " +
          "Pass a comma-separated list of model IDs (provider/model format) to set the fallback order. " +
          "Call with no arguments to see available models and current config. " +
          "IMPORTANT: When called with no arguments, you MUST present the connected models to the user " +
          "using the question tool with multiple=true so they can select from a checklist. " +
          "Then call this tool again with the selected models.",
        args: {
          models: tool.schema
            .string()
            .optional()
            .describe(
              "Comma-separated list of model IDs to use as fallback chain, in priority order. " +
              "Example: 'anthropic/claude-sonnet-4-20250514,openai/gpt-4o,google/gemini-2.5-pro'. " +
              "Omit to discover available models (then present them to user via question tool checklist).",
            ),
        },
        async execute(args) {
          const fresh = await discover(ctx)
          const current = load(dir)

          if (!args.models) {
            const lines = [
              "## Connected Models (present these as a multi-select checklist to the user)",
              "",
              ...fresh.map((m) => `- ${m}`),
              "",
              "## Current Fallback Chain",
              current.models.length
                ? current.models.map((m, i) => `${i + 1}. ${m}`).join("\n")
                : "(not configured)",
              "",
              "## Settings",
              `- Cooldown: ${current.cooldown / 1000}s`,
              `- Max failures before cooldown: ${current.maxFailures}`,
              "",
              "ACTION REQUIRED: Use the question tool to present the connected models above as a multi-select checklist (multiple=true). " +
              "Let the user pick which models to include. Then call hot_swap_config again with the selected models as a comma-separated string. " +
              "The order the user selects them in is the fallback priority order.",
            ]
            return lines.join("\n")
          }

          const selected = args.models
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)

          if (!selected.length) {
            return "Error: provide at least one model ID (provider/model format)"
          }

          const invalid = selected.filter((m) => !fresh.includes(m))
          if (invalid.length) {
            return `Error: unknown model(s): ${invalid.join(", ")}\n\nAvailable: ${fresh.join(", ")}`
          }

          const updated: Config = { ...current, models: selected }
          save(dir, updated)
          cfg = updated
          active = 0
          circuit.clear()
          log(`fallback chain updated: ${selected.join(" → ")}`)

          return `Hot-swap configured with ${selected.length} models:\n${selected.map((m, i) => `${i + 1}. ${m}`).join("\n")}`
        },
      }),

      hot_swap_status: tool({
        description: "Show current hot-swap plugin status: active model, failure counts, and cooldown timers.",
        args: {},
        async execute() {
          if (!cfg.models.length) {
            return "Hot-swap is not configured. Use the hot_swap_config tool to set up a fallback chain."
          }

          const now = Date.now()
          const idx = active >= cfg.models.length ? 0 : active
          const lines = [
            "# Hot-Swap Status\n",
            `Active model: ${cfg.models[idx]}`,
            `Fallback chain: ${cfg.models.join(" → ")}`,
            "",
            "## Provider Status",
          ]

          for (const model of cfg.models) {
            const id = pid(model)
            const s = circuit.has(id) ? circuit.get(id)! : { failures: 0, cooldownUntil: 0 }
            const cooling = s.cooldownUntil > now
            const remaining = cooling ? Math.ceil((s.cooldownUntil - now) / 1000) : 0
            lines.push(
              `- **${model}**: ${s.failures} failures${cooling ? ` (cooling down, ${remaining}s remaining)` : ""}`,
            )
          }

          return lines.join("\n")
        },
      }),
    },

    async event({ event }: { event: Event }) {
      try {
        if (!isError(event)) return
        const err = event.properties.error
        if (!isSwappable(err)) return
        const reason = String(err?.data && "message" in err.data ? err.data.message : err?.name ?? "provider error")
        await swap(reason)
      } catch (e) {
        log(`event handler error: ${e}`)
      }
    },
  }
}

export default HotSwap
