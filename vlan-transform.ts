#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

import { command, run as runBinary, string, option, boolean, flag, multioption } from "cmd-ts";
import { parse } from "@std/yaml";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// Zod schemas for validation
const VlanStatusSchema = z.enum(["tagged", "pvid"]);

const AuthConfigSchema = z.object({
  type: z.enum(["xike"]),
  user: z.string(),
  pass: z.string(),
  resp: z.string(),
});

const VlanConfigSchema = z.object({
  vlans: z.record(z.coerce.number(), z.string()),
  templates: z.record(z.string(), z.record(z.coerce.number(), VlanStatusSchema)),
  switches: z.record(z.string(), z.object({
    name: z.string(),
    address: z.string(),
    auth: AuthConfigSchema,
    ports: z.array(z.object({
      name: z.string(),
      template: z.string(),
    })),
  })),
});

type VlanConfig = z.infer<typeof VlanConfigSchema>;

interface PortVlan {
  [vlanId: string]: "tagged" | "pvid" | "not-member";
}

interface PortConfig {
  name: string;
  vlans: PortVlan;
}

interface VlanPortMembership {
  vlanId: number;
  vlanName: string;
  ports: {
    [portName: string]: "tagged" | "pvid" | "not-member";
  };
}

interface SwitchConfig {
  switch: string;
  name: string;
  address: string;
  vlans: VlanPortMembership[];
}

interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface SwitchHttpRequests {
  switch: string;
  address: string;
  requests: HttpRequest[];
}

function filterConfig(config: VlanConfig, switchFilters: string[], vlanFilters: string[]): VlanConfig {
  const filtered: VlanConfig = {
    vlans: {},
    templates: config.templates,
    switches: {},
  };

  // Filter VLANs
  if (vlanFilters.length > 0) {
    for (const [vlanId, vlanName] of Object.entries(config.vlans)) {
      // Check if this VLAN matches any of the filters
      const matches = vlanFilters.some(filter => {
        const filterNum = parseInt(filter);
        const isNumeric = !isNaN(filterNum);

        const matchesId = isNumeric && filterNum.toString() === vlanId;
        const matchesName = vlanName.toLowerCase() === filter.toLowerCase();

        return matchesId || matchesName;
      });

      if (matches) {
        filtered.vlans[Number(vlanId)] = vlanName;
      }
    }

    if (Object.keys(filtered.vlans).length === 0) {
      console.error(`Warning: No VLAN found matching any of: ${vlanFilters.join(', ')}`);
    }
  } else {
    filtered.vlans = config.vlans;
  }

  // Filter switches
  if (switchFilters.length > 0) {
    for (const [switchName, switchData] of Object.entries(config.switches)) {
      if (switchFilters.includes(switchName)) {
        filtered.switches[switchName] = switchData;
      }
    }

    if (Object.keys(filtered.switches).length === 0) {
      console.error(`Warning: No switch found matching any of: ${switchFilters.join(', ')}`);
    }
  } else {
    filtered.switches = config.switches;
  }

  return filtered;
}

function transformVlans(config: VlanConfig): SwitchConfig[] {
  const result: SwitchConfig[] = [];

  for (const [switchName, switchData] of Object.entries(config.switches)) {
    const vlanMemberships: VlanPortMembership[] = [];

    // For each VLAN, build port membership
    for (const [vlanId, vlanName] of Object.entries(config.vlans)) {
      const vlanIdNum = Number(vlanId);
      const ports: { [portName: string]: "tagged" | "pvid" | "not-member" } = {};

      // Check each port's membership for this VLAN
      for (const portConfig of switchData.ports) {
        const template = config.templates[portConfig.template];

        if (!template) {
          console.error(`Warning: Template '${portConfig.template}' not found for ${switchName}:${portConfig.name}`);
          ports[portConfig.name] = "not-member";
          continue;
        }

        const status = template[vlanIdNum];

        if (status === "pvid" || status === "tagged") {
          ports[portConfig.name] = status;
        } else {
          ports[portConfig.name] = "not-member";
        }
      }

      vlanMemberships.push({
        vlanId: vlanIdNum,
        vlanName,
        ports,
      });
    }

    result.push({
      switch: switchName,
      name: switchData.name,
      address: switchData.address,
      vlans: vlanMemberships,
    });
  }

  return result;
}

function generateHttpRequests(config: VlanConfig, cookies: Map<string, string>): SwitchHttpRequests[] {
  const result: SwitchHttpRequests[] = [];

  for (const [switchName, switchData] of Object.entries(config.switches)) {
    const requests: HttpRequest[] = [];
    const cookie = cookies.get(switchName) || "";

    // Build port configurations for each VLAN
    for (const [vlanId, vlanName] of Object.entries(config.vlans)) {
      const vlanIdNum = Number(vlanId);
      const portParams: string[] = [];

      // Add vid and name parameters
      portParams.push(`vid=${vlanIdNum}`);
      portParams.push(`name=${encodeURIComponent(vlanName)}`);

      // For each port, determine its membership status for this VLAN
      for (let portIndex = 0; portIndex < switchData.ports.length; portIndex++) {
        const portConfig = switchData.ports[portIndex];
        const template = config.templates[portConfig.template];

        if (!template) {
          console.error(`Warning: Template '${portConfig.template}' not found for ${switchName}:${portConfig.name}`);
          portParams.push(`vlanPort_${portIndex}=0`);
          continue;
        }

        const status = template[vlanIdNum];
        let statusValue: number;

        // Map status to numeric value
        // 0 = not-member, 1 = pvid/untagged, 2 = tagged
        if (status === "pvid") {
          statusValue = 0;
        } else if (status === "tagged") {
          statusValue = 1;
        } else {
          statusValue = 2;
        }

        portParams.push(`vlanPort_${portIndex}=${statusValue}`);
      }

      const body = portParams.join("&");
      const url = `/vlan.cgi?page=static`;

      const headers: Record<string, string> = {
        "Host": switchData.address,
        "User-Agent": "curl/8.7.1",
        "Accept": "*/*",
        "Cookie": `${switchData.auth.user}=${switchData.auth.resp}`,
        "Content-Length": body.length.toString(),
        "Content-Type": "application/x-www-form-urlencoded",
      };

      requests.push({
        method: "POST",
        url,
        headers,
        body,
      });
    }

    // Generate PVID configuration requests for each port
    for (let portIndex = 0; portIndex < switchData.ports.length; portIndex++) {
      const portConfig = switchData.ports[portIndex];
      const template = config.templates[portConfig.template];

      if (!template) {
        continue;
      }

      // Find the VLAN that has pvid status for this port
      for (const [vlanId, vlanName] of Object.entries(config.vlans)) {
        const vlanIdNum = Number(vlanId);
        const status = template[vlanIdNum];

        if (status === "pvid") {
          // Generate PVID configuration request for this port
          const pvidBody = `ports=${portIndex}&pvid=${vlanIdNum}&vlan_accept_frame_type=0`;
          const pvidUrl = `/vlan.cgi?page=port_based`;

          const pvidHeaders: Record<string, string> = {
            "Host": switchData.address,
            "User-Agent": "curl/8.7.1",
            "Accept": "*/*",
            "Cookie": `${switchData.auth.user}=${switchData.auth.resp}`,
            "Content-Length": pvidBody.length.toString(),
            "Content-Type": "application/x-www-form-urlencoded",
          };

          requests.push({
            method: "POST",
            url: pvidUrl,
            headers: pvidHeaders,
            body: pvidBody,
          });

          // A port can only have one PVID, so break after finding it
          break;
        }
      }
    }

    result.push({
      switch: switchName,
      address: switchData.address,
      requests,
    });
  }

  return result;
}

function formatHttpRequest(req: HttpRequest, address: string): string {
  let output = `${req.method} ${req.url} HTTP/1.1\n`;

  for (const [key, value] of Object.entries(req.headers)) {
    output += `${key}: ${value}\n`;
  }

  output += `\n${req.body}\n`;

  return output;
}

async function customFetch(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  headers: Map<string, string>;
}> {
  const urlObj = new URL(url);
  const hostname = urlObj.hostname;
  const port = urlObj.port ? parseInt(urlObj.port) : 80;
  const path = urlObj.pathname + urlObj.search;
  const method = options?.method || 'GET';
  const headers = options?.headers || {};
  const body = options?.body || '';

  const conn = await Deno.connect({ hostname, port });

  let requestStr = `${method} ${path} HTTP/1.1\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    requestStr += `${key}: ${value}\r\n`;
  }
  requestStr += `\r\n${body}`;

  const requestBytes = new TextEncoder().encode(requestStr);
  await conn.write(requestBytes);

  const buffer = new Uint8Array(8192);
  const bytesRead = await conn.read(buffer);
  conn.close();

  if (!bytesRead) {
    throw new Error("No response from server");
  }

  const responseText = new TextDecoder().decode(buffer.subarray(0, bytesRead));
  const [statusLine, ...headerLines] = responseText.split('\r\n');
  const statusMatch = statusLine.match(/HTTP\/1\.\d (\d+) (.+)/);

  if (!statusMatch) {
    throw new Error("Invalid HTTP response");
  }

  const status = parseInt(statusMatch[1]);
  const statusText = statusMatch[2];

  const responseHeaders = new Map<string, string>();
  let i = 0;
  for (; i < headerLines.length; i++) {
    if (headerLines[i] === '') break;
    const [key, ...valueParts] = headerLines[i].split(': ');
    if (key && valueParts.length > 0) {
      responseHeaders.set(key.toLowerCase(), valueParts.join(': '));
    }
  }

  const bodyStartIndex = responseText.indexOf('\r\n\r\n');
  const responseBody = bodyStartIndex >= 0 ? responseText.substring(bodyStartIndex + 4) : '';

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => responseBody,
    headers: responseHeaders,
  };
}

async function loginToSwitch(
  switchName: string,
  address: string,
  auth: { type: "xike"; user: string; pass: string; resp: string },
  verbose: boolean = false
): Promise<{ success: boolean; cookie?: string; error?: string }> {
  try {
    if (verbose) {
      console.log(`  Logging in to ${switchName}...`);
    }

    return {
      success: true,
      cookie: `${auth.user}=${auth.resp}`
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeHttpRequest(
  address: string,
  req: HttpRequest,
  verbose: boolean = false
): Promise<{ success: boolean; status?: number; statusText?: string; error?: string; body?: string }> {
  try {
    const url = `http://${address}${req.url}`;

    if (verbose) {
      console.log(`  URL: ${url}`);
      console.log(`  Body: ${req.body}`);
    }

    const response = await customFetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });

    const responseBody = await response.text();

    if (verbose) {
      console.log(`  Response Status: ${response.status} ${response.statusText}`);
      console.log(`  Response Body: ${responseBody.substring(0, 200)}${responseBody.length > 200 ? '...' : ''}`);
    }

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: responseBody,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const cmd = command({
  name: "vlan-transform",
  description: "Transform vlans.yaml into switch port configuration",
  version: "1.0.0",
  args: {
    file: option({
      type: string,
      long: "file",
      short: "f",
      description: "Path to vlans.yaml file",
      defaultValue: () => "vlans.yaml",
    }),
    http: flag({
      long: "http",
      description: "Output HTTP POST requests instead of JSON",
      defaultValue: () => false,
    }),
    switch: multioption({
      type: string,
      long: "switch",
      short: "s",
      description: "Filter by switch name (can be specified multiple times)",
    }),
    vlan: multioption({
      type: string,
      long: "vlan",
      short: "v",
      description: "Filter by VLAN ID or name (can be specified multiple times)",
    }),
    execute: flag({
      long: "execute",
      short: "x",
      description: "Execute HTTP POST requests to the switches (requires --http)",
      defaultValue: () => false,
    }),
    verbose: flag({
      long: "verbose",
      description: "Show detailed request/response information when executing",
      defaultValue: () => false,
    }),
    save: flag({
      long: "save",
      description: "Save configuration after applying changes (requires --execute)",
      defaultValue: () => false,
    }),
  },
  handler: async ({ file, http, switch: switchFilter, vlan: vlanFilter, execute, verbose, save }) => {
    try {
      const content = await readFile(file, "utf-8");
      const rawConfig = parse(content);

      // Validate with Zod
      const parseResult = VlanConfigSchema.safeParse(rawConfig);

      if (!parseResult.success) {
        console.error("Validation error in configuration file:");
        console.error(parseResult.error.format());
        Deno.exit(1);
      }

      const config = parseResult.data;

      // Apply filters (multioption returns arrays)
      const filteredConfig = filterConfig(
        config,
        switchFilter,
        vlanFilter
      );

      if (http) {
        if (save && !execute) {
          console.error("Error: --save requires --execute flag");
          Deno.exit(1);
        }

        const cookies = new Map<string, string>();

        if (execute) {
          console.log("\n# Authenticating to switches...\n");

          for (const [switchName, switchData] of Object.entries(filteredConfig.switches)) {
            if (!switchData.auth) {
              console.error(`  ✗ No auth config found for ${switchName}`);
              continue;
            }

            console.log(`Logging in to ${switchName} (${switchData.address})...`);

            const loginResult = await loginToSwitch(
              switchName,
              switchData.address,
              switchData.auth,
              verbose
            );

            if (loginResult.success && loginResult.cookie) {
              console.log(`  ✓ Login successful`);
              if (verbose) {
                console.log(`  Cookie: ${loginResult.cookie}`);
              }
              cookies.set(switchName, loginResult.cookie);
            } else {
              console.error(`  ✗ Login failed: ${loginResult.error}`);
            }
          }

          console.log("\n# Configuring VLANs...\n");
        }

        const httpRequests = generateHttpRequests(filteredConfig, cookies);

        if (execute) {
          // Execute the VLAN and PVID configuration requests
          for (const switchReqs of httpRequests) {
            console.log(`\n# Configuring switch: ${switchReqs.switch} (${switchReqs.address})`);
            console.log(`# ${switchReqs.requests.length} configuration requests (VLAN membership + PVID)\n`);

            for (let i = 0; i < switchReqs.requests.length; i++) {
              const req = switchReqs.requests[i];

              // Extract VLAN or PVID info from body for better logging
              const vlanMatch = req.body.match(/vid=(\d+)&name=([^&]+)/);
              const pvidMatch = req.body.match(/ports=(\d+)&pvid=(\d+)/);

              let requestInfo: string;
              if (vlanMatch) {
                requestInfo = `VLAN ${vlanMatch[1]} (${decodeURIComponent(vlanMatch[2])})`;
              } else if (pvidMatch) {
                requestInfo = `Port ${pvidMatch[1]} PVID ${pvidMatch[2]}`;
              } else {
                requestInfo = `Request ${i + 1}`;
              }

              console.log(`Configuring ${requestInfo}...`);

              const result = await executeHttpRequest(switchReqs.address, req, verbose);

              if (result.success) {
                console.log(`  ✓ Success: ${result.status} ${result.statusText}`);
              } else {
                console.error(`  ✗ Failed: ${result.error || `${result.status} ${result.statusText}`}`);
              }
            }

            console.log(`\nCompleted ${switchReqs.switch}\n`);
          }

          // Save configuration if --save flag is set
          if (save) {
            console.log("\n# Saving configuration...\n");

            for (const switchReqs of httpRequests) {
              const switchName = switchReqs.switch;
              const switchData = filteredConfig.switches[switchName];

              if (!switchData) continue;

              console.log(`Saving configuration for ${switchName} (${switchReqs.address})...`);

              const saveReq: HttpRequest = {
                method: "POST",
                url: "/save.cgi",
                headers: {
                  "Host": switchData.address,
                  "User-Agent": "curl/8.7.1",
                  "Accept": "*/*",
                  "Cookie": cookies.get(switchName) || `${switchData.auth.user}=${switchData.auth.resp}`,
                  "Content-Length": "0",
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: "",
              };

              const result = await executeHttpRequest(switchReqs.address, saveReq, verbose);

              if (result.success) {
                console.log(`  ✓ Configuration saved: ${result.status} ${result.statusText}`);
              } else {
                console.error(`  ✗ Save failed: ${result.error || `${result.status} ${result.statusText}`}`);
              }
            }

            console.log("");
          }
        } else {
          // Just display the requests
          for (const switchReqs of httpRequests) {
            console.log(`\n# Switch: ${switchReqs.switch} (${switchReqs.address})`);
            console.log(`# ${switchReqs.requests.length} configuration requests (VLAN membership + PVID)\n`);

            for (let i = 0; i < switchReqs.requests.length; i++) {
              const req = switchReqs.requests[i];
              console.log(`## Request ${i + 1}`);
              console.log(formatHttpRequest(req, switchReqs.address));
              console.log("---\n");
            }
          }
        }
      } else {
        if (execute) {
          console.error("Error: --execute requires --http flag");
          Deno.exit(1);
        }
        if (save) {
          console.error("Error: --save requires --execute flag");
          Deno.exit(1);
        }
        const result = transformVlans(filteredConfig);
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : String(error));
      Deno.exit(1);
    }
  },
});

runBinary(cmd, Deno.args);
