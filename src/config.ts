import { readFileSync, existsSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { homedir } from "node:os"

// ── Minimal JSONC parser ─────────────────────────────────────────────────
function stripJsonComments(text: string): string {
  let result = ""
  let inString = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      result += ch
      if (ch === "\\") {
        result += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      result += ch
      i++
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    result += ch
    i++
  }
  return result
}

function readJsonc(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf-8")
  return JSON.parse(stripJsonComments(raw))
}

// ── Config shape ─────────────────────────────────────────────────────────

export interface WireguardProxyConfig {
  /** Path to wireproxy binary. */
  binary: string
  /** Path to wireproxy .conf file (WireGuard/AmneziaWG config + [http] section). */
  config: string
  /** Domains routed through the tunnel. Subdomains included automatically. */
  hosts: string[]
  /** Proxy port override. Default: read from wireproxy.conf BindAddress. */
  port?: number
  /** Path to JSONC config file (set internally by the loader). */
  configPath?: string
}

// ── Validation ───────────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString)
}

function validate(raw: unknown): WireguardProxyConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a JSON object")
  }
  const obj = raw as Record<string, unknown>

  if (!isString(obj.binary)) {
    throw new Error("binary: required string (path to wireproxy binary)")
  }
  if (!isString(obj.config)) {
    throw new Error("config: required string (path to wireproxy .conf)")
  }
  if (!isStringArray(obj.hosts)) {
    throw new Error("hosts: required array of non-empty strings")
  }
  if (obj.port !== undefined) {
    const port = Number(obj.port)
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error("port: must be a number between 1 and 65535")
    }
  }

  return {
    binary: obj.binary as string,
    config: obj.config as string,
    hosts: obj.hosts as string[],
    port: obj.port !== undefined ? Number(obj.port) : undefined,
  }
}

// ── Path resolution ──────────────────────────────────────────────────────

function resolveRelative(base: string, ...segments: string[]): string {
  const joined = join(...segments)
  if (resolve(joined) === joined) return joined
  return resolve(base, joined)
}

// ── Config discovery ─────────────────────────────────────────────────────

const CONFIG_FILENAME = "wireguard-proxy.jsonc"

interface DiscoveryContext {
  options?: Record<string, unknown>
  worktree?: string
}

/**
 * Find and load the config file. Priority:
 *   1. options.configPath (explicit path from plugin options)
 *   2. ${worktree}/.opencode/wireguard-proxy.jsonc (project-level)
 *   3. ~/.config/opencode/wireguard-proxy.jsonc (global-level)
 */
export function loadConfig(ctx: DiscoveryContext = {}): WireguardProxyConfig {
  const candidates: { path: string; label: string }[] = []

  if (isString(ctx.options?.configPath)) {
    candidates.push({ path: ctx.options.configPath as string, label: "plugin options" })
  }

  if (ctx.worktree) {
    candidates.push({
      path: join(ctx.worktree, ".opencode", CONFIG_FILENAME),
      label: "project .opencode/",
    })
  }

  candidates.push({
    path: join(homedir(), ".config", "opencode", CONFIG_FILENAME),
    label: "global ~/.config/opencode/",
  })

  let configPath: string | undefined
  let label: string | undefined

  for (const c of candidates) {
    if (existsSync(c.path)) {
      configPath = c.path
      label = c.label
      break
    }
  }

  if (!configPath) {
    const searched = candidates.map((c) => `  - ${c.path} (${c.label})`).join("\n")
    throw new Error(
      `[opencode-wireguard-proxy] Config not found. Create ${CONFIG_FILENAME} in one of:\n${searched}`,
    )
  }

  const configDir = dirname(configPath)
  const raw = readJsonc(configPath)
  const config = validate(raw)

  config.binary = resolveRelative(configDir, config.binary)
  config.config = resolveRelative(configDir, config.config)
  config.configPath = configPath

  if (!existsSync(config.binary)) {
    throw new Error(
      `[opencode-wireguard-proxy] wireproxy binary not found at: ${config.binary}\n` +
        `Download from https://github.com/windtf/wireproxy/releases (standard WireGuard)\n` +
        `or https://github.com/bropines/awg-wireproxy/releases (AmneziaWG)`,
    )
  }
  if (!existsSync(config.config)) {
    throw new Error(
      `[opencode-wireguard-proxy] wireproxy config not found at: ${config.config}`,
    )
  }

  return config
}
