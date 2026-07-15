export type ProxyStatus = "idle" | "connecting" | "running" | "reused" | "error"

export interface ProxyState {
  status: ProxyStatus
  proxyUrl: string
  port: number
  proxiedHosts: string[]
  error: string | null
}

export const proxyState: ProxyState = {
  status: "idle",
  proxyUrl: "",
  port: 0,
  proxiedHosts: [],
  error: null,
}
