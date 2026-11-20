// Claude Code's stream-json protocol, folded into chat items. No UI and no
// herdr calls, so it can be tested on its own (scripts/chat.test.ts).
//
// Items:
//   { kind: "user", text }
//   { kind: "text", text, streaming }                 assistant prose (markdown)
//   { kind: "thinking", text, streaming }
//   { kind: "tool", id, name, input, result, error, done }
//   { kind: "ask", request, tool, input, suggestions, answered }   a permission or question
//   { kind: "note", text, level }                     errors, interruptions, compactions
//   { kind: "turn", cost, ms, error }                 end of one answer

export const ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];

/** The command line for a chat: resume a session, start in a model and mode. */
export function args({ session, model, mode } = {}) {
  const out = [...ARGS];
  if (session) out.push("--resume", session);
  if (model) out.push("--model", model);
  if (mode && mode !== "default") out.push("--permission-mode", mode);
  return out;
}

/** Claude Code's folder for a project's transcripts: every other character becomes "-". */
export function projectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export const userMessage = (text) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
let requests = 0;
export const control = (request) => ({ type: "control_request", request_id: `herdr-${Date.now()}-${++requests}`, request });

/** The reply to a permission request. `choice`: "allow", "always", "deny"; `input` replaces the tool's input. */
export function permissionReply(ask, choice, input) {
  const response = choice === "deny"
    ? { behavior: "deny", message: "The user declined this in the chat." }
    : { behavior: "allow", updatedInput: input ?? ask.input, ...(choice === "always" && ask.suggestions?.length ? { updatedPermissions: ask.suggestions } : {}) };
  return { type: "control_response", response: { subtype: "success", request_id: ask.request, response } };
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => c.type === "text" ? c.text : c.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

/** Text the person typed, not what Claude Code adds to a user turn (reminders, command output). */
function typed(content) {
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
  const t = text.trim();
  if (!t || t.startsWith("<") || t.startsWith("Caveat:") || t.startsWith("[Request interrupted")) return null;
  return t;
}

export class Transcript {
  constructor() {
    this.items = [];
    this.open = null;          // the block now streaming
    this.tools = new Map();    // tool_use id -> item
    this.busy = false;         // an answer is coming
    this.session = null;
    this.model = null;
    this.cwd = null;
    this.mode = null;
    this.commands = [];
    this.cost = 0;
  }

  push(item) { this.items.push(item); return item; }
  note(text, level = "info") { return this.push({ kind: "note", text, level }); }
  user(text) { this.busy = true; return this.push({ kind: "user", text }); }

  /** Permission and question cards still waiting for the person. */
  pending() { return this.items.filter(i => i.kind === "ask" && !i.answered); }

  close() {
    if (this.open) this.open.streaming = false;
    this.open = null;
  }

  block(b, live) {
    if (b.type === "text") {
      if (live && this.open?.kind === "text") { this.open.text = b.text; this.close(); return; }
      if (b.text?.trim()) this.push({ kind: "text", text: b.text, streaming: false });
    } else if (b.type === "thinking") {
      if (live && this.open?.kind === "thinking") { if (b.thinking) this.open.text = b.thinking; this.close(); return; }
      if (b.thinking?.trim()) this.push({ kind: "thinking", text: b.thinking, streaming: false });
    } else if (b.type === "redacted_thinking") {
      this.close();
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      const known = this.tools.get(b.id);
      if (known) { known.input = b.input ?? known.input; known.name = b.name ?? known.name; }
      else this.tools.set(b.id, this.push({ kind: "tool", id: b.id, name: b.name, input: b.input ?? {}, result: null, error: false, done: false }));
      if (this.open?.kind === "tool") this.close();
    }
  }

  /** One line of claude's output. Returns what the view may want to react to. */
  apply(m) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.session = m.session_id; this.model = m.model; this.cwd = m.cwd;
          this.mode = m.permissionMode ?? this.mode;
          if (Array.isArray(m.slash_commands)) this.commands = m.slash_commands;
          return { init: true };
        }
        if (m.subtype === "compact_boundary") this.note("Conversation compacted");
        if (m.subtype === "status" && m.status === "compacting") this.note("Compacting conversation…");
        return null;

      case "stream_event": {
        const e = m.event;
        if (m.parent_tool_use_id) return null; // a sub-agent's stream: its tool card covers it
        if (e.type === "content_block_start") {
          this.close();
          const c = e.content_block;
          if (c.type === "text") this.open = this.push({ kind: "text", text: c.text ?? "", streaming: true });
          else if (c.type === "thinking") this.open = this.push({ kind: "thinking", text: c.thinking ?? "", streaming: true });
          else if (c.type === "tool_use" || c.type === "server_tool_use") {
            this.block(c, true);
            this.open = this.tools.get(c.id);
          }
        } else if (e.type === "content_block_delta" && this.open) {
          const d = e.delta;
          if (d.type === "text_delta" && this.open.kind === "text") this.open.text += d.text;
          else if (d.type === "thinking_delta" && this.open.kind === "thinking") this.open.text += d.thinking;
        } else if (e.type === "content_block_stop") {
          this.close();
        }
        return { stream: true };
      }

      case "assistant": {
        if (m.parent_tool_use_id) return null;
        const blocks = m.message?.content ?? [];
        for (const b of blocks) this.block(b, blocks.length === 1);
        if (m.error) this.note(m.error === "authentication_failed" ? "Claude Code isn't signed in. Run `claude` in a terminal to log in." : `Error: ${m.error}`, "error");
        return null;
      }

      case "user": {
        if (m.parent_tool_use_id) return null;
        const content = m.message?.content;
        if (Array.isArray(content)) for (const c of content) {
          if (c.type !== "tool_result") continue;
          const tool = this.tools.get(c.tool_use_id);
          if (!tool) continue;
          tool.result = resultText(c.content);
          tool.error = Boolean(c.is_error);
          tool.done = true;
        }
        // Replayed history (a resumed session) carries what the person typed.
        if (m.replay) { const t = typed(content); if (t) this.push({ kind: "user", text: t }); }
        return null;
      }

      case "control_request": {
        const r = m.request;
        if (r?.subtype !== "can_use_tool") return null;
        const ask = this.push({
          kind: "ask", request: m.request_id, tool: r.tool_name, input: r.input ?? {}, tool_use: r.tool_use_id,
          suggestions: r.permission_suggestions ?? [], description: r.description ?? null, answered: null,
        });
        return { ask };
      }

      case "control_response":
        if (Array.isArray(m.response?.response?.commands)) this.commands = m.response.response.commands.map(c => c.name);
        return null;

      case "result": {
        this.close();
        this.busy = false;
        for (const t of this.tools.values()) if (!t.done) { t.done = true; }
        for (const a of this.pending()) a.answered = "expired";
        if (m.session_id) this.session = m.session_id;
        if (typeof m.total_cost_usd === "number") this.cost = m.total_cost_usd;
        const error = m.is_error ? (m.result || m.subtype || "error") : null;
        this.push({ kind: "turn", cost: m.total_cost_usd ?? null, ms: m.duration_ms ?? null, error });
        return { done: true, error };
      }
    }
    return null;
  }

  /** A transcript file (~/.claude/projects/<dir>/<session>.jsonl): what was said, up to `limit` items. */
  load(jsonl, limit = 400) {
    for (const line of jsonl.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.isSidechain || e.isMeta) continue;
      if (e.type === "assistant") this.apply({ type: "assistant", message: e.message });
      else if (e.type === "user") this.apply({ type: "user", message: e.message, replay: true });
      else if (e.type === "summary" || e.type === "system") continue;
    }
    this.close();
    for (const t of this.tools.values()) t.done = true;
    if (this.items.length > limit) this.items = [{ kind: "note", text: `${this.items.length - limit} earlier messages not shown`, level: "info" }, ...this.items.slice(-limit)];
    if (this.items.length) this.push({ kind: "note", text: "Resumed conversation", level: "info" });
  }
}

const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

/** A tool call in a few words: "Bash" + its command, "Edit" + the file. */
export function summary(name, input = {}) {
  switch (name) {
    case "Bash": case "PowerShell": return input.description || input.command?.split("\n")[0] || "";
    case "Read": case "Write": case "Edit": case "MultiEdit": return base(input.file_path);
    case "NotebookEdit": return base(input.notebook_path);
    case "Glob": return input.pattern ?? "";
    case "Grep": return `${input.pattern ?? ""}${input.path ? `  in ${base(input.path)}` : ""}`;
    case "WebFetch": return input.url ?? "";
    case "WebSearch": return input.query ?? "";
    case "Task": case "Agent": return input.description ?? "";
    case "TodoWrite": return `${(input.todos ?? []).length} todos`;
    case "Skill": return input.skill ?? "";
    case "ExitPlanMode": return "Plan ready";
    case "AskUserQuestion": return (input.questions ?? []).map(q => q.header || q.question).join(", ");
    default: {
      const s = JSON.stringify(input);
      return s === "{}" ? "" : s.slice(0, 90);
    }
  }
}

/** What a tool call does, in detail: lines with a "+", "-" or " " mark for diffs. */
export function details(name, input = {}) {
  const lines = (s, mark = " ") => String(s ?? "").split("\n").map(l => ({ mark, text: l }));
  switch (name) {
    case "Bash": case "PowerShell": return lines(input.command, "$");
    case "Edit": return [...lines(input.old_string, "-"), ...lines(input.new_string, "+")];
    case "MultiEdit": return (input.edits ?? []).flatMap((e, i) => [...(i ? [{ mark: " ", text: "…" }] : []), ...lines(e.old_string, "-"), ...lines(e.new_string, "+")]);
    case "Write": return lines(input.content, "+");
    case "TodoWrite": return (input.todos ?? []).map(t => ({ mark: t.status === "completed" ? "✓" : t.status === "in_progress" ? "›" : "·", text: t.content }));
    default: return lines(JSON.stringify(input, null, 2));
  }
}
