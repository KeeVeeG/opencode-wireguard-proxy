# opencode-wireguard-proxy

[OpenCode](https://opencode.ai) plugin that routes specific hostnames through a
WireGuard or AmneziaWG tunnel via [wireproxy](https://github.com/windtf/wireproxy),
a userspace WireGuard client that exposes an HTTP proxy.

No admin rights. No TUN interface. No system-wide routing changes.
Only the traffic you choose goes through the VPN.

## How it works

```
OpenCode fetch (Bun)
  ├── openrouter.ai → HTTP proxy (localhost) → wireproxy → WireGuard tunnel → VPN
  └── everything else → direct connection
```

The plugin reads your config, spawns wireproxy as a child process (userspace, no
root), patches `globalThis.fetch` to route matching hostnames through the HTTP
proxy using Bun's native `proxy` option, and kills wireproxy when OpenCode exits.

## Setup

### 1. Download wireproxy

This plugin does not bundle the wireproxy binary. Download it separately.

| Variant | When to use | Download |
|---------|-------------|----------|
| Standard WireGuard | Regular WireGuard VPN server | [windtf/wireproxy/releases](https://github.com/windtf/wireproxy/releases) |
| AmneziaWG | Server uses AmneziaWG obfuscation (DPI bypass) | [bropines/awg-wireproxy/releases](https://github.com/bropines/awg-wireproxy/releases) |

If your wireproxy.conf has `Jc`, `H1` through `H4` (AmneziaWG parameters), you
must use the AmneziaWG fork. Standard wireproxy silently ignores these fields
and the tunnel will not connect.

Place the binary anywhere and reference it in the config.

### 2. Create config files

Create `wireguard-proxy.jsonc` in `~/.config/opencode/` (global) or `.opencode/`
(per-project).

```jsonc
{
  "binary": "C:/Users/you/wireproxy/wireproxy.exe",
  "config": "C:/Users/you/wireproxy/wireproxy.conf",
  "hosts": ["openrouter.ai"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `binary` | Yes | Path to wireproxy binary. Relative paths resolve from config file directory. |
| `config` | Yes | Path to wireproxy `.conf` file. Relative paths resolve from config file directory. |
| `hosts` | Yes | Domains to route through the tunnel. Subdomains included automatically. Empty array disables routing. |
| `port` | No | Override proxy port. Default: from `[http] BindAddress` in wireproxy.conf, fallback 25345. |

Create `wireproxy.conf` as a standard WireGuard or AmneziaWG config with an
`[http]` section. See the [wireproxy README](https://github.com/windtf/wireproxy)
for the format.

### 3. Register the plugin

Add to your `opencode.json`. OpenCode installs npm packages listed in the plugin
array automatically on restart.

```jsonc
{
  "plugin": [
    "@keeveeg/opencode-wireguard-proxy"
  ]
}
```

Or with a custom config path:

```jsonc
{
  "plugin": [
    ["@keeveeg/opencode-wireguard-proxy", {
      "configPath": "/path/to/wireguard-proxy.jsonc"
    }]
  ]
}
```

Restart OpenCode for the plugin to load.

## Usage

Once configured, OpenCode routes requests to your configured hosts through the
VPN and leaves all other traffic (LM Studio, npm, MCP servers, and so on)
direct.

Use `/wg-proxy-status` to check the proxy status (URL, port, proxied hosts). The
command is registered automatically when the plugin loads.

## Limitations

- **Bun runtime required.** Uses `Bun.spawn` and Bun's `fetch` with the `proxy`
  option. OpenCode runs on Bun, so this works out of the box.
- **HTTP proxy only.** Only HTTP and HTTPS traffic is tunneled. WebSocket and
  raw TCP or UDP bypass the tunnel. DNS for proxied hosts is resolved through
  the proxy via the tunnel.
- **One instance per port.** Multiple OpenCode instances share the same proxy
  port. The plugin reuses an existing proxy if the port is already open.

## License

MIT
