# xikestor-sks3200-tools

CLI tools for managing Xikestor SKS-3200 managed switches.

## Tools

### switch-stats

HTTP metrics exporter (InfluxDB line protocol) for Telegraf. Scrapes port statistics from switch web UIs.

- Listens on `:9100`
- `GET /metrics` — port stats in InfluxDB line protocol
- `GET /health` — health check

Config via `VLANS_YAML` env var (default `/config/vlans.yaml`).

### vlan-transform

CLI tool to transform a `vlans.yaml` config into VLAN membership and PVID configuration, then optionally apply it to switches via HTTP.

```
vlan-transform -f vlans.yaml                        # JSON output
vlan-transform -f vlans.yaml --http                  # show HTTP requests
vlan-transform -f vlans.yaml --http -x               # execute requests
vlan-transform -f vlans.yaml --http -x --save        # execute + save config
vlan-transform -f vlans.yaml -s sw1 -v 100           # filter by switch/VLAN
```

## Docker

Multi-stage image with both tools compiled as static binaries.

```
docker pull ghcr.io/mabels/xikestor-sks3200-tools:latest
```

Default entrypoint is `switch-stats`. To run `vlan-transform`:

```
docker run --rm \
  -v ./vlans.yaml:/config/vlans.yaml:ro \
  ghcr.io/mabels/xikestor-sks3200-tools:latest \
  vlan-transform -f /config/vlans.yaml --http -x --save
```

## Development

Requires [Deno](https://deno.land/).

```
deno run --allow-net --allow-read --allow-env switch-stats.ts
deno run --allow-net --allow-read --allow-env --allow-write vlan-transform.ts -f vlans.yaml
```
