import { readFileSync } from "node:fs"
import net from "node:net"
import type { WireguardProxyConfig } from "./config.js"

// ── Port check ───────────────────────────────────────────────────────────

export function isPortOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)
    const done = (result: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.on("connect", () => done(true))
    socket.on("error", () => done(false))
    socket.on("timeout", () => done(false))
    socket.connect(port, host)
  })
}

async function waitForPort(
  host: string,
  port: number,
  maxRetries = 10,
  delayMs = 500,
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    if (await isPortOpen(host, port)) return true
    await new Promise<void>((r) => setTimeout(r, delayMs))
  }
  return false
}

// ── Wireproxy lifecycle ──────────────────────────────────────────────────

export interface ProxyHandle {
  proxyUrl: string
  port: number
  _reused: boolean
  dispose(): Promise<void>
}

const DEFAULT_PORT = 25345

/**
 * Parse the port from a wireproxy.conf [http] BindAddress line.
 */
function parseBindPort(confPath: string): number | undefined {
  try {
    const content = readFileSync(confPath, "utf-8")
    const match = content.match(/\[http\][\s\S]*?BindAddress\s*=\s*\S+:(\d+)/i)
    if (match) return parseInt(match[1], 10)
  } catch {
    // ignore — fall back to default
  }
  return undefined
}

/**
 * Start wireproxy and wait for the HTTP proxy to become available.
 */
export async function startProxy(
  config: WireguardProxyConfig,
): Promise<ProxyHandle> {
  const host = "127.0.0.1"
  const port = config.port ?? parseBindPort(config.config) ?? DEFAULT_PORT
  const proxyUrl = `http://${host}:${port}`

  // ── Reuse existing proxy if port is already open ─────────────────────
  if (await isPortOpen(host, port, 1000)) {
    return {
      proxyUrl,
      port,
      _reused: true,
      dispose: async () => {
        // Don't kill someone else's process
      },
    }
  }

  // ── Validate wireproxy config before spawning ────────────────────────
  const configtest = Bun.spawnSync({
    cmd: [config.binary, "-c", config.config, "-n"],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!configtest.success) {
    const stderr = configtest.stderr?.toString().trim()
    throw new Error(`wireproxy config validation failed:\n${stderr}`)
  }

  // ── Spawn wireproxy ──────────────────────────────────────────────────
  const proc = Bun.spawn({
    cmd: [config.binary, "-c", config.config],
    stdout: "ignore",
    stderr: "pipe",
  })

  // Capture stderr for diagnostics
  let stderrBuf = ""
  const stderrDone = (async () => {
    if (!proc.stderr) return
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        stderrBuf += decoder.decode(value, { stream: true })
      }
    } catch {
      // process exited — expected
    }
  })()

  // Race: port ready vs process exit
  const exitError = proc.exited.then(async (code) => {
    await stderrDone.catch(() => {})
    if (code !== 0) {
      const tail = stderrBuf.trim().split("\n").slice(-5).join("\n")
      return new Error(`wireproxy exited with code ${code}\n${tail}`)
    }
    return null
  })

  const result = await Promise.race([
    waitForPort(host, port, 15, 500).then((ready) => ({ kind: "port" as const, ready })),
    exitError.then((err) => ({ kind: "exit" as const, err })),
  ])

  if (result.kind === "exit" || !result.ready) {
    try { proc.kill() } catch { /* already exited */ }
    await stderrDone.catch(() => {})
    if (result.kind === "exit" && result.err) throw result.err
    const tail = stderrBuf.trim().split("\n").slice(-5).join("\n")
    throw new Error(
      `Proxy port ${port} did not open within 7.5 s.\n` +
        `Check that the VPN endpoint is reachable.\n` +
        (tail ? `wireproxy stderr:\n${tail}` : ""),
    )
  }

  return {
    proxyUrl,
    port,
    _reused: false,
    dispose: async () => {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    },
  }
}
