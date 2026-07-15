import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { startProxy, type ProxyHandle } from "./proxy.js"
import { patchFetch } from "./fetch-patch.js"
import { proxyState } from "./state.js"

function formatStatus(): string {
  const s = proxyState
  if (s.status === "error") {
    return `WireGuard Proxy: error\n${s.error}`
  }
  if (s.status === "idle" || s.status === "connecting") {
    return `WireGuard Proxy: ${s.status}`
  }
  return [
    `WireGuard Proxy: active`,
    `Proxy URL: ${s.proxyUrl}`,
    `Port: ${s.port}`,
    `Proxied hosts: ${s.proxiedHosts.join(", ")}`,
  ].join("\n")
}

const COMMAND_NAME = "wg-proxy-status"

export default (async (input: PluginInput, options?: PluginOptions) => {
  const client = input.client

  // ── Register command ────────────────────────────────────────────────
  const registerCommand = async (cfg: any) => {
    cfg.command = {
      ...(cfg.command ?? {}),
      [COMMAND_NAME]: {
        template: formatStatus(),
        description: "Show WireGuard proxy status",
      },
    }
  }

  // ── Load config ────────────────────────────────────────────────────
  let config
  try {
    config = loadConfig({
      options: options as Record<string, unknown> | undefined,
      worktree: input.worktree,
    })
  } catch (err) {
    proxyState.status = "error"
    proxyState.error = err instanceof Error ? err.message : String(err)
    return { config: registerCommand }
  }

  if (config.hosts.length === 0) {
    return {}
  }

  // ── Start wireproxy ────────────────────────────────────────────────
  proxyState.status = "connecting"
  proxyState.proxiedHosts = config.hosts

  let proxy: ProxyHandle
  try {
    proxy = await startProxy(config)
  } catch (err) {
    proxyState.status = "error"
    proxyState.error = err instanceof Error ? err.message : String(err)
    return {
      config: registerCommand,
      tool: {
        "wg-proxy-status": tool({
          description: "Check the status of the WireGuard proxy",
          args: {},
          execute: async () => formatStatus(),
        }),
      },
    }
  }

  // ── Patch fetch ────────────────────────────────────────────────────
  const restoreFetch = patchFetch(config.hosts, proxy.proxyUrl)

  proxyState.status = proxy._reused ? "reused" : "running"
  proxyState.proxyUrl = proxy.proxyUrl
  proxyState.port = proxy.port
  proxyState.error = null

  // ── Hooks ──────────────────────────────────────────────────────────
  return {
    config: registerCommand,
    "command.execute.before": async (cmdInput, output) => {
      if (cmdInput.command === COMMAND_NAME) {
        try {
          await client.tui.showToast({
            body: {
              message: formatStatus(),
              variant: proxyState.status === "error" ? "error" : "info",
              title: "WireGuard Proxy",
            },
          })
        } catch {}
        throw new Error("wg-proxy-status: command handled via toast")
      }
    },
    tool: {
      "wg-proxy-status": tool({
        description: "Check the status of the WireGuard proxy",
        args: {},
        execute: async () => formatStatus(),
      }),
    },
    dispose: async () => {
      restoreFetch()
      await proxy.dispose()
      proxyState.status = "idle"
    },
  }
}) satisfies Plugin
