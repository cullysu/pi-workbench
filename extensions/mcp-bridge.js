/**
 * pi extension: MCP bridge.
 *
 * Reads ~/.pi/agent/mcp.json ({ "mcpServers": { name: { command, args?, env? } } })
 * and exposes every MCP tool as a native pi tool named mcp_<server>_<tool>.
 * Connections are lazy: a server process is spawned on the first call to one of
 * its tools and reused afterwards. Requires `npm install` next to this file
 * (typebox); the workbench's MCP page does that for you.
 */
import { Type } from "typebox";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MCP_CONFIG = path.join(os.homedir(), ".pi", "agent", "mcp.json");
const CALL_TIMEOUT_MS = 120000;
const START_TIMEOUT_MS = 30000;

function readServers() {
  try {
    const cfg = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8"));
    return cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {};
  } catch {
    return {};
  }
}

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "srv";

class McpClient {
  constructor(name, conf, log) {
    this.name = name;
    this.conf = conf;
    this.log = log;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.ready = null;
    this.tools = null;
  }

  _send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  _request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "notifications/message" && msg.params?.data) {
      this.log(`[${this.name}] ${String(msg.params.data).slice(0, 200)}`);
    }
    // other server notifications are ignored
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const { command, args = [], env = {} } = this.conf;
      // windows: npx/uvx etc. are .cmd shims — direct spawn() throws ENOENT, so go through cmd
      const useShell = process.platform === 'win32';
      const exe = useShell ? (process.env.ComSpec || 'cmd.exe') : command;
      const argv = useShell ? ['/d', '/s', '/c', command, ...args] : args;
      this.proc = spawn(exe, argv, {
        cwd: os.homedir(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc.on('error', (e) => {
        this.log(`[${this.name}] spawn failed: ${e.message}`);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
        this.pending.clear();
        try { this.proc?.kill(); } catch {}
        this.proc = null;
        this.ready = null;
        this.tools = null;
      });
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (chunk) => {
        this.buffer += chunk;
        let i;
        while ((i = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, i).replace(/\r$/, "");
          this.buffer = this.buffer.slice(i + 1);
          this._handleLine(line);
        }
      });
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", (c) => this.log(`[${this.name}] ${String(c).trim().slice(0, 200)}`));
      this.proc.on("exit", (code) => {
        this.log(`[${this.name}] exited (code ${code})`);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`mcp server exited (code ${code})`)); }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        this.tools = null;
      });

      const init = await this._request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-mcp-bridge", version: "0.1.0" },
      }, START_TIMEOUT_MS);
      this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return init;
    })();
    return this.ready;
  }

  async listTools() {
    await this.connect();
    if (!this.tools) {
      const res = await this._request("tools/list", {});
      this.tools = res.tools || [];
    }
    return this.tools;
  }

  async callTool(toolName, args) {
    await this.connect();
    const res = await this._request("tools/call", { name: toolName, arguments: args || {} });
    const out = [];
    for (const item of res.content || []) {
      if (item.type === "text") out.push(item.text);
      else out.push(`[${item.type} content] ` + JSON.stringify(item).slice(0, 2000));
    }
    const text = out.join("\n") || "(empty result)";
    return { text, isError: res.isError === true };
  }

  shutdown() {
    try { this.proc?.kill(); } catch {}
  }
}

export default function mcpBridge(pi) {
  const clients = new Map(); // server name -> McpClient
  const log = (line) => { try { console.log("[mcp-bridge]", line); } catch {} };

  const getClient = (name, conf) => {
    if (!clients.has(name)) clients.set(name, new McpClient(name, conf, log));
    return clients.get(name);
  };

  const servers = readServers();
  const registered = [];

  const registerAll = async () => {
    const entries = Object.entries(servers);
    if (!entries.length) {
      log(`no servers configured in ${MCP_CONFIG}`);
      return;
    }
    for (const [srvName, conf] of entries) {
      const client = getClient(srvName, conf);
      let tools = [];
      try {
        tools = await client.listTools();
      } catch (e) {
        // a dead MCP server must not take the whole session down
        log(`skipping ${srvName}: ${e.message}`);
        continue;
      }
      for (const tool of tools) {
        const base = `mcp_${sanitize(srvName)}_${sanitize(tool.name)}`;
        let name = base;
        for (let n = 2; registered.includes(name); n++) name = `${base}_${n}`;
        const schema = tool.inputSchema && tool.inputSchema.type === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} };
        registered.push(name);
        try {
          pi.registerTool({
            name,
            label: `${srvName}: ${tool.name}`,
            description: tool.description || `MCP tool ${tool.name} from server ${srvName}`,
            promptSnippet: `${tool.description || tool.name} (MCP server: ${srvName})`,
            parameters: Type.Unsafe(schema),
            async execute(_toolCallId, params) {
              const c = getClient(srvName, conf);
              try {
                const r = await c.callTool(tool.name, params);
                return {
                  content: [{ type: "text", text: r.text }],
                  details: { mcp: true, server: srvName, tool: tool.name, isError: r.isError },
                };
              } catch (e) {
                return {
                  content: [{ type: "text", text: `MCP error (${srvName}.${tool.name}): ${e.message}` }],
                  details: { mcp: true, server: srvName, tool: tool.name, isError: true },
                };
              }
            },
          });
          log(`registered ${name}`);
        } catch (e) {
          log(`failed to register ${name}: ${e.message}`);
        }
      }
    }
  };

  const run = registerAll();
  if (run && typeof run.catch === "function") run.catch((e) => log(`init failed: ${e.message}`));

  // best-effort cleanup when the session ends
  pi.on?.("session_shutdown", () => { for (const c of clients.values()) c.shutdown(); });
}
