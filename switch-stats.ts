import { DOMParser, initParser } from "jsr:@b-fuze/deno-dom/wasm-noinit";
import { parse } from "jsr:@std/yaml@1";
import { timeouted, unwrap, Lazy } from "jsr:@adviser/cement";

interface SwitchConfig {
  name: string;
  address: string;
  cookie: string;
  ports: string[];
}

interface Config {
  switches: SwitchConfig[];
  timeoutMs: number;
  cacheMs: number;
}

function loadConfig(): Config {
  const configPath = Deno.env.get("VLANS_YAML") ?? "/config/vlans.yaml";
  const raw = parse(Deno.readTextFileSync(configPath)) as Record<string, unknown>;
  const stats = (raw.stats ?? {}) as Record<string, unknown>;
  const switches = raw.switches as Record<string, {
    address: string;
    auth: { user: string; resp: string };
    ports: { name: string }[];
  }>;
  return {
    timeoutMs: Number(stats.timeout_ms ?? 10_000),
    cacheMs: Number(stats.cache_ms ?? 55_000),
    switches: Object.entries(switches).map(([name, sw]) => ({
      name,
      address: sw.address,
      cookie: `${sw.auth.user}=${sw.auth.resp}`,
      ports: sw.ports.map((p) => p.name),
    })),
  };
}

async function httpGet(hostname: string, path: string, cookie: string, timeoutMs: number): Promise<string> {
  const result = await timeouted(async () => {
    const conn = await Deno.connect({ hostname, port: 80 });
    try {
      const req =
        `GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`;
      await conn.write(new TextEncoder().encode(req));
      const buf = new Uint8Array(4096);
      let raw = "";
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        raw += new TextDecoder().decode(buf.subarray(0, n));
      }
      const bodyStart = raw.indexOf("\r\n\r\n");
      if (bodyStart < 0) throw new Error("no HTTP body");
      return raw.substring(bodyStart + 4);
    } finally {
      conn.close();
    }
  }, { timeout: timeoutMs });
  return unwrap(result);
}

async function fetchStats(sw: SwitchConfig, timeoutMs: number): Promise<string[]> {
  let html: string;
  try {
    html = await httpGet(sw.address, "/port.cgi?page=stats", sw.cookie, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${sw.name} (${sw.address}): fetch failed: ${msg}`);
    return [`# ERROR ${sw.name} (${sw.address}): ${msg}`];
  }

  if (html.includes("login.cgi")) {
    console.error(`${sw.name} (${sw.address}): auth rejected, got login redirect`);
    return [`# ERROR ${sw.name} (${sw.address}): auth rejected`];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) {
    console.error(`${sw.name}: failed to parse HTML`);
    return [`# ERROR ${sw.name}: failed to parse HTML`];
  }

  const rows = doc.querySelectorAll("table tr");
  const lines: string[] = [];
  let portIndex = 0;

  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length !== 7) continue;

    const state = cells[1].textContent.trim();
    const linkStatus = cells[2].textContent.trim();
    const txGood = cells[3].textContent.trim();
    const txBad = cells[4].textContent.trim();
    const rxGood = cells[5].textContent.trim();
    const rxBad = cells[6].textContent.trim();

    const portName = sw.ports[portIndex] ?? `port${portIndex + 1}`;
    const linkUp = linkStatus === "Link Up" ? 1 : 0;

    const tags = `switch=${sw.name},host=${sw.address},port=${portName}`;
    const fields = `state="${state}",link_up=${linkUp}i,tx_good=${txGood}i,tx_bad=${txBad}i,rx_good=${rxGood}i,rx_bad=${rxBad}i`;
    lines.push(`switch_port,${tags} ${fields}`);

    portIndex++;
  }

  if (portIndex === 0) {
    console.error(`${sw.name} (${sw.address}): no port rows found in HTML`);
    return [`# ERROR ${sw.name}: no port rows in response`];
  }

  return lines;
}

async function collectMetrics(config: Config): Promise<string> {
  const results = await Promise.allSettled(
    config.switches.map((sw) => fetchStats(sw, config.timeoutMs)),
  );

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      lines.push(...r.value);
    } else {
      const name = config.switches[i].name;
      console.error(`${name}: ${r.reason}`);
      lines.push(`# ERROR ${name}: ${r.reason}`);
    }
  }

  return lines.join("\n") + "\n";
}

async function main() {
  const config = loadConfig();
  await initParser();

  const cachedMetrics = Lazy(
    () => collectMetrics(config),
    { resetAfter: config.cacheMs },
  );

  Deno.serve({ port: 9100 }, async (req: Request) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/metrics") {
      const body = await cachedMetrics();
      return new Response(body, {
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (pathname === "/health") return new Response("ok\n");
    return new Response("not found\n", { status: 404 });
  });
}

main();
