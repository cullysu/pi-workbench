/**
 * pi extension: MCP bridge.
 *
 * Reads ~/.pi/agent/mcp.json ({ "mcpServers": { name: { command, args?, env?, lazy? } } })
 * and exposes MCP tools as native pi tools named mcp_<server>_<tool>.
 * Default servers are registered eagerly (spawn + listTools at startup) so the
 * model sees fully typed tools. Servers marked `"lazy": true` cost nothing at
 * startup: they get two meta-tools (mcp_<srv>_list / mcp_<srv>_call) and the
 * process is spawned on the first call. Requires `npm install` next to this file
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
    if (!this.proc) throw new Error(`mcp client ${this.name} is closed`); // a racing send after a failed start must not TypeError on null
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  _killTree() {
    // .kill() only reaches the DIRECT child — on Windows that is the cmd.exe wrapper,
    // and the real server (npx → node …) survives as an unmanaged orphan (audit #27)
    const p = this.proc;
    if (!p || p.pid === undefined) { try { p?.kill(); } catch { /* gone */ } return; }
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => { try { p.kill(); } catch { /* gone */ } });
      } else {
        try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch { /* gone */ } }
      }
    } catch { try { p.kill(); } catch { /* gone */ } }
  }

  _request(method, params, timeoutMs = CALL_TIMEOUT_MS, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`${method} aborted before start`));
      const id = this.nextId++;
      let onAbort = null;
      const cleanupAbort = () => { if (onAbort && signal) signal.removeEventListener("abort", onAbort); };
      const timer = setTimeout(() => {
        cleanupAbort();
        this.pending.delete(id);
        // the timeout must cancel protocol-side too — the remote tool would keep
        // running side effects with nobody waiting on the result
        try { this._send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } }); } catch { /* transport gone */ }
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          // protocol-level cancel: tell the server to stop the work, then fail the call
          try { this._send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "user aborted" } }); } catch { /* transport gone */ }
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`${method} cancelled by user abort`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (v) => { cleanupAbort(); resolve(v); },
        reject: (e) => { cleanupAbort(); reject(e); },
        timer,
      });
      try {
        this._send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        cleanupAbort();
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
    if (!msg || typeof msg !== "object") return; // a literal `null` line is valid JSON — msg.id must not TypeError (audit #26)
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "notifications/message" && msg.params?.data) {
      const d = msg.params.data;
      this.log(`[${this.name}] ${(typeof d === "string" ? d : JSON.stringify(d)).slice(0, 200)}`);
    }
    // other server notifications are ignored
  }

  async connect() {
    if (this.ready) return this.ready;
    const { command, args = [], env = {} } = this.conf;
    // P2-7 (v1.3.9 review): a non-string command reached spawn() and, on Windows,
    // cmd.exe /c — an object or number got coerced into a command line. Validate here
    // too: the config route is not the only way a bridge gets constructed.
    if (typeof command !== "string" || !command.trim()) {
      throw new Error(`mcp server "${this.name}" has no usable command (got ${typeof command})`);
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new Error(`mcp server "${this.name}" args must be an array of strings`);
    }
    const p = (async () => {
      // windows: npx/uvx etc. are .cmd shims — direct spawn() throws ENOENT, so go through cmd
      const useShell = process.platform === 'win32';
      const exe = useShell ? (process.env.ComSpec || 'cmd.exe') : command;
      const argv = useShell ? ['/d', '/s', '/c', command, ...args] : args;
      const proc = this.proc = spawn(exe, argv, {
        cwd: os.homedir(),
        // v1.3.8 review P1-2: the GUI admin token is scrubbed from server.mjs's own
        // environment, but this bridge is also loaded by pi, which inherits whatever the
        // shell gave it. Drop it again here so a third-party MCP server can never read it
        // out of `env` even if a future launcher forgets the scrub.
        env: (() => { const e = { ...process.env, ...env }; delete e.PIWB_TOKEN; delete e.PIWB_EMBED_TOKEN; return e; })(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32', // POSIX: own process group so _killTree can reap the whole tree
      });
      this.proc.on('error', (e) => {
        this.log(`[${this.name}] spawn failed: ${e.message}`);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
        this.pending.clear();
        this._killTree();
        this.proc = null;
        this.ready = null;
        this.tools = null;
      });
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (chunk) => {
        if (this.proc !== proc) return; // a replaced client owns proc/pending/buffer now — a stale child's stdout must not pollute it (audit #25)
        this.buffer += chunk;
        if (this.buffer.length > 16 * 1024 * 1024) {
          // a server flooding stdout without newlines must not balloon memory:
          // fail the pending calls and reset for a clean retry
          this.log(`[${this.name}] stdout overflow (>16MB without a newline) — resetting`);
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("mcp server stdout overflow")); }
          this.pending.clear();
          this._killTree();
          this.proc = null; this.ready = null; this.tools = null; this.buffer = "";
          return;
        }
        let i;
        while ((i = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, i).replace(/\r$/, "");
          this.buffer = this.buffer.slice(i + 1);
          this._handleLine(line);
        }
      });
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", (c) => { if (this.proc !== proc) return; this.log(`[${this.name}] ${String(c).trim().slice(0, 200)}`); });
      const self = this;
      this.proc.on("exit", (code) => {
        if (self.proc !== proc) return; // a NEWER process owns this client — a stale exit must not tear it down
        this.log(`[${this.name}] exited (code ${code})`);
        if (this.buffer.trim()) this._handleLine(this.buffer.trim()); // flush the final newline-less line BEFORE failing the pending calls it may answer
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`mcp server exited (code ${code})`)); }
        this.pending.clear();
        this.buffer = "";
        this.proc = null;
        this.ready = null;
        this.tools = null;
      });
      this.proc.stdin?.on?.("error", () => {}); // an async EPIPE after the server dies must not become an unhandled stream error

      try {
        const init = await this._request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pi-mcp-bridge", version: "0.1.0" },
        }, START_TIMEOUT_MS);
        this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
        return init;
      } catch (e) {
        // a failed start must not poison this.ready forever: kill the half-started
        // process and reset, so the next tool call gets a real retry instead of the
        // cached rejection (a cold `npx` download routinely exceeds the init timeout)
        this.log(`[${this.name}] initialize failed: ${e.message} — resetting for retry`);
        this._killTree();
        this.proc = null;
        this.ready = null;
        this.tools = null;
        throw e;
      }
    })();
    // P2-7 (v1.3.9 review): the body reset `this.ready` on its OWN failure paths, but a
    // throw from a path that forgot to (or from the validation above) left a REJECTED
    // promise cached forever — every later call got the same stale rejection instead of a
    // retry. Clearing here makes the reset path-independent.
    p.catch(() => { if (this.ready === p) this.ready = null; });
    this.ready = p;
    return p;
  }

  async listTools() {
    await this.connect();
    if (!this.tools) {
      let res = await this._request("tools/list", {});
      let tools = res.tools || [];
      let cursor = res.nextCursor; // servers may paginate — stop at page one and tools silently vanish
      while (cursor) {
        res = await this._request("tools/list", { cursor });
        tools = tools.concat(res.tools || []);
        cursor = res.nextCursor;
      }
      this.tools = tools;
    }
    return this.tools;
  }

  async callTool(toolName, args, signal) {
    await this.connect();
    const res = await this._request("tools/call", { name: toolName, arguments: args || {} }, CALL_TIMEOUT_MS, signal);
    const out = [];
    for (const item of res.content || []) {
      if (item.type === "text") out.push(item.text);
      else out.push(`[${item.type} content] ` + JSON.stringify(item).slice(0, 2000));
    }
    let text = out.join("\n") || "(empty result)";
    const MAX_RESULT_CHARS = 256 * 1024; // a runaway MCP server must not pour unbounded text into pi's context
    if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + `\n[…truncated: ${text.length} → ${MAX_RESULT_CHARS} chars]`;
    return { text, isError: res.isError === true };
  }

  shutdown() {
    this._killTree(); // best-effort, tree-wide: the shutdown path used to leave the real server running behind the cmd wrapper
  }
}

export default function mcpBridge(pi) {
  const clients = new Map(); // server name -> McpClient
  const log = (line) => { try { console.log("[mcp-bridge]", line); } catch { /* stdout must never throw */ } };

  const getClient = (name, conf) => {
    if (!clients.has(name)) clients.set(name, new McpClient(name, conf, log));
    return clients.get(name);
  };

  const servers = readServers();
  const registered = [];

  // lazy servers (config `"lazy": true`) cost nothing at startup: no spawn, no
  // listTools — instead two meta-tools are registered and the real connection is
  // made on the first call. Default stays eager so the model keeps seeing fully
  // typed tools with their real schemas.
  const registerLazyServer = (srvName, conf) => {
    const base0 = `mcp_${sanitize(srvName)}`;
    let base = base0;
    for (let n = 2; registered.includes(`${base}_call`); n++) base = `${base0}_${n}`; // foo-bar and foo_bar sanitize identically — dedupe like the eager path
    const listName = `${base}_list`;
    const callName = `${base}_call`;
    try {
      pi.registerTool({
        name: listName,
        label: `${srvName}: list tools`,
        description: `List the tools available on lazy MCP server "${srvName}"`,
        promptSnippet: `MCP server "${srvName}" is lazy-loaded — call ${listName} first to discover its tools`,
        parameters: Type.Unsafe({ type: "object", properties: {} }),
        async execute() {
          const tools = await getClient(srvName, conf).listTools();
          const brief = tools.map((t) => ({
            name: t.name,
            description: t.description || "",
            params: Object.keys(t.inputSchema?.properties || {}),
            required: t.inputSchema?.required || [],
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(brief, null, 2) }],
            details: { mcp: true, server: srvName },
          };
        },
      });
      pi.registerTool({
        name: callName,
        label: `${srvName}: call tool`,
        description: `Call a tool on the lazy MCP server "${srvName}". Use ${listName} first to discover tool names.`,
        promptSnippet: `Call tools on the lazy MCP server "${srvName}"`,
        parameters: Type.Unsafe({
          type: "object",
          properties: { tool: { type: "string", description: "tool name as reported by " + listName }, arguments: { type: "object", description: "tool arguments object" } },
          required: ["tool"],
        }),
        async execute(_toolCallId, params, signal) {
          const c = getClient(srvName, conf);
          let r;
          try {
            r = await c.callTool(params.tool, params.arguments || {}, signal);
          } catch (e) {
            // transport/timeout/cancel are failures at pi's layer too — pi-agent-core
            // marks the tool failed only when execute THROWS (details are UI metadata)
            throw new Error(`MCP ${srvName}.${params.tool} failed: ${e.message}`);
          }
          // an MCP-level failure must reach pi's execution layer as a failure — a returned
          // result (even carrying an isError detail) parses as success, so we throw instead
          if (r.isError) throw new Error(`MCP ${srvName}.${params.tool} failed: ${String(r.text).slice(0, 2000)}`);
          return {
            content: [{ type: "text", text: r.text }],
            details: { mcp: true, server: srvName, tool: params.tool },
          };
        },
      });
      registered.push(listName, callName);
      log(`lazy-registered ${srvName} (connects on first call)`);
    } catch (e) {
      log(`failed to lazy-register ${srvName}: ${e.message}`);
    }
  };

  const registerAll = async () => {
    const entries = Object.entries(servers);
    if (!entries.length) {
      log(`no servers configured in ${MCP_CONFIG}`);
      return;
    }
    for (const [srvName, conf] of entries) {
      if (conf && conf.lazy) { registerLazyServer(srvName, conf); continue; }
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
            async execute(_toolCallId, params, signal) {
              const c = getClient(srvName, conf);
              let r;
              try {
                r = await c.callTool(tool.name, params, signal);
              } catch (e) {
                throw new Error(`MCP ${srvName}.${tool.name} failed: ${e.message}`); // same layer rule
              }
              if (r.isError) throw new Error(`MCP ${srvName}.${tool.name} failed: ${String(r.text).slice(0, 2000)}`);
              return {
                content: [{ type: "text", text: r.text }],
                details: { mcp: true, server: srvName, tool: tool.name },
              };
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
