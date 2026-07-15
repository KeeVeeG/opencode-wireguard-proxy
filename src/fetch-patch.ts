// ── Fetch patching for Bun ───────────────────────────────────────────────
//
// Bun's native fetch supports a `proxy` string option:
//   fetch(url, { proxy: "http://127.0.0.1:25345" })
//
// We override globalThis.fetch to route matching hostnames through the
// wireproxy HTTP proxy. Everything else goes direct.

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
