// ── Fetch patching for Bun ───────────────────────────────────────────────
//
// Bun's native fetch supports a `proxy` string option:
//   fetch(url, { proxy: "http://127.0.0.1:25345" })
//
// We override globalThis.fetch to:
//   1. Route matching hostnames through the wireproxy HTTP proxy.
//   2. Filter out orphaned empty assistant messages that cause
//      "must not be empty" errors on providers like Moonshot AI.
//      See: https://github.com/anomalyco/opencode/issues/6056

/**
 * Filter empty assistant messages from request body.
 *
 * Some providers (e.g. Moonshot AI) reject requests with empty assistant
 * messages that have no tool_calls. These are created when a tool call is
 * cancelled mid-stream. We strip them to prevent provider errors.
 *
 * Messages with tool_calls are kept even if content is empty — they are part
 * of valid tool-call chains.
 */
function filterEmptyAssistantMessages(body: Record<string, unknown>): boolean {
  const messages = body.messages
  if (!Array.isArray(messages)) return false

  const before = messages.length
  body.messages = messages.filter((msg: Record<string, unknown>) => {
    if (msg.role !== "assistant") return true

    const content = msg.content
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0

    const isEmpty =
      !content ||
      (typeof content === "string" && content.trim() === "") ||
      (Array.isArray(content) && content.length === 0)

    // Keep if has tool_calls, remove only if truly empty/orphaned
    return !(isEmpty && !hasToolCalls)
  })

  return (body.messages as unknown[]).length !== before
}

function shouldProxy(url: string, hosts: Set<string>): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    for (const h of hosts) {
      if (hostname === h || hostname.endsWith("." + h)) return true
    }
    return false
  } catch {
    return false
  }
}

function extractUrl(input: unknown): string | null {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  if (input && typeof input === "object" && typeof (input as any).url === "string") {
    return (input as any).url as string
  }
  return null
}

/**
 * Patch globalThis.fetch to route requests matching `proxiedHosts`
 * through the given HTTP proxy URL. Returns a restore function.
 */
export function patchFetch(proxiedHosts: string[], proxyUrl: string): () => void {
  if (proxiedHosts.length === 0) {
    return () => {}
  }

  const hostSet = new Set(proxiedHosts.map((h) => h.toLowerCase()))
  const originalFetch = globalThis.fetch

  globalThis.fetch = function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // Filter empty assistant messages from JSON bodies (issue #6056)
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body)
        if (body.messages && filterEmptyAssistantMessages(body)) {
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch {
        // Not JSON or parse error — pass through
      }
    }

    const url = extractUrl(input)
    if (url && shouldProxy(url, hostSet)) {
      // Bun reads `proxy` from the init object before creating the Request.
      return originalFetch(input, { ...init, proxy: proxyUrl } as RequestInit)
    }
    return originalFetch(input, init)
  } as typeof globalThis.fetch

  return () => {
    globalThis.fetch = originalFetch
  }
}
