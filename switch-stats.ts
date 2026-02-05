import { DOMParser } from "jsr:@b-fuze/deno-dom";
import { parse } from "jsr:@std/yaml@1";

interface SwitchConfig {
  name: string;
  address: string;
  cookie: string;
  ports: string[];
}

interface Config {
  switches: SwitchConfig[];
}

function loadConfig(): Config {
  const configPath = Deno.env.get("VLANS_YAML") ?? "/config/vlans.yaml";
  const raw = parse(Deno.readTextFileSync(configPath)) as Record<string, unknown>;
  const switches = raw.switches as Record<string, {
    address: string;
    auth: { user: string; resp: string };
    ports: { name: string }[];
  }>;
  return {
    switches: Object.entries(switches).map(([name, sw]) => ({
      name,
      address: sw.address,
      cookie: `${sw.auth.user}=${sw.auth.resp}`,
      ports: sw.ports.map((p) => p.name),
    })),
  };
}

const config = loadConfig();

async function httpGet(hostname: string, path: string, cookie: string): Promise<string> {
  const conn = await Deno.connect({ hostname, port: 80 });
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
  conn.close();
  const bodyStart = raw.indexOf("\r\n\r\n");
  if (bodyStart < 0) throw new Error("no HTTP body");
  return raw.substring(bodyStart + 4);
}

async function fetchStats(sw: SwitchConfig): Promise<string[]> {
  let html: string;
  try {
    html = await httpGet(sw.address, "/port.cgi?page=stats", sw.cookie);
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

async function handleMetrics(): Promise<Response> {
  const results = await Promise.allSettled(
    config.switches.map((sw) => fetchStats(sw)),
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

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain" },
  });
}

Deno.serve({ port: 9100 }, (req: Request) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/metrics") return handleMetrics();
  if (pathname === "/health") return new Response("ok\n");
  return new Response("not found\n", { status: 404 });
});
