// A chat with Claude Code: claude runs headless (stream-json) and this pane
// draws the conversation, its tool calls and permission questions, and a
// composer. Open one with the + menu's "Claude chat", or
//   run("tab.new", { name: "Claude", mod: "chat", props: { chat: "<unique id>", folder } })
// Each chat keeps its Claude session in localStorage (per props), so it
// resumes where it was after a restart.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextView, TextareaState, Textarea } from "gpui-base";
import { theme, settings, props, spaces, home, window, spawn, readProcess, writeProcess, killProcess, checking, playSound, notify, run } from "herdr";
import * as fs from "fs/promises";
import { Transcript, args, projectDir, userMessage, control, permissionReply, summary, details } from "./session.js";

const MODELS = [
  { id: null, label: "Default model" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
const MODES = [
  { id: "default", label: "Ask before edits" },
  { id: "acceptEdits", label: "Edit automatically" },
  { id: "plan", label: "Plan mode" },
];
const RESULT_LINES = 14;

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
  return value;
}

/** A theme color (#rgb, #rrggbb or #rrggbbaa) at the given alpha ("00".."ff"). */
function tint(color, alpha) {
  const c = String(color ?? "");
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map(x => x + x).join("")}${alpha}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return `${c.slice(0, 7)}${alpha}`;
  return c;
}

async function exists(path) {
  try { return await fs.exists(path); } catch { return false; }
}

/** claude.exe itself where npm or the native installer put it; else the name (PATH finds claude.cmd). */
async function claudeCommand() {
  if (window()?.platform !== "windows") return "claude";
  const h = home();
  for (const p of [`${h}\\.local\\bin\\claude.exe`, `${h}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]) {
    if (await exists(p)) return p;
  }
  return "claude";
}

export default class Chat extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.folder = p.folder || spaces().find(s => s.active)?.folder || home();
    const saved = store("chat") ?? {};
    this.model = saved.model ?? null;
    this.mode = saved.mode ?? "default";
    this.t = new Transcript();
    this.open = new Set();      // expanded tool cards and thinking blocks, by index
    this.proc = null;
    this.queue = [];            // messages waiting for claude to start
    this.ended = null;          // why claude stopped, when it did
    this.stderr = [];
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Ask Claude to do something…  (Enter to send, Shift+Enter for a new line)" });
    this.input.set_auto_grow(1, 12);
    this.input.set_submit_on_enter?.(true);
    this.input.on("submit", (e, cx) => { if (!e?.shift) this.send(cx); });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.focus();
    if (checking()) return;
    cx.spawn(async cx => {
      if (saved.session) await this.restore(saved.session);
      this.start(cx, saved.session);
      // props.prompt: the first message of a new chat (like tab.new's task for a terminal agent).
      if (!saved.session && p.prompt && !store("prompted")) {
        store("prompted", true);
        this.input.set_value(String(p.prompt));
        this.send(cx);
      }
      this.follow();
      cx.notify();
    });
  }

  save() {
    store("chat", { session: this.t.session, model: this.model, mode: this.mode });
  }

  async restore(session) {
    try {
      const file = `${home()}/.claude/projects/${projectDir(this.folder)}/${session}.jsonl`;
      this.t.load(await fs.readFile(file, "utf8"));
    } catch { /* a missing transcript just starts empty; --resume still knows it */ }
  }

  async start(cx, session) {
    this.ended = null;
    this.stderr = [];
    this.starting = true;
    let id;
    try {
      id = spawn(await claudeCommand(), args({ session, model: this.model, mode: this.mode }), { cwd: this.folder });
    } catch (e) {
      this.ended = `Couldn't start Claude Code: ${e?.message ?? e}. Is \`claude\` installed and on PATH?`;
      this.queue = [];
      this.t.busy = false;
      cx.notify();
      return;
    } finally {
      this.starting = false;
    }
    this.proc = id;
    // Asks for the slash commands (and readies the session) before the first message.
    this.write(control({ subtype: "initialize" }));
    for (const m of this.queue.splice(0)) this.write(m);
    cx.spawn(async cx => {
      for (;;) {
        let batch;
        try { batch = await readProcess(id); } catch { batch = null; }
        if (!batch || this.proc !== id) break;
        for (const line of batch.lines) this.handle(line);
        if (batch.stderr.length) this.stderr = [...this.stderr, ...batch.stderr].slice(-20);
        if (batch.exit !== null) {
          this.proc = null;
          this.t.close();
          this.t.busy = false;
          const why = this.stderr.filter(l => l.trim() && !l.includes("[mcp-sdk]")).slice(-3).join("\n");
          this.ended = batch.exit === 0 ? "Claude Code stopped." : `Claude Code exited (${batch.exit}).${why ? `\n${why}` : ""}`;
        }
        this.follow();
        cx.notify();
        if (batch.exit !== null) break;
      }
    });
  }

  handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const r = this.t.apply(m);
    if (r?.init) this.save();
    if (r?.ask) {
      if (!window()?.active) playSound("blocked");
    }
    if (r?.done && !window()?.active) {
      playSound("done");
      notify({ title: "Claude finished", body: this.lastText()?.slice(0, 140) ?? "", level: r.error ? "error" : "success" });
    }
  }

  lastText() {
    for (let i = this.t.items.length - 1; i >= 0; i--) if (this.t.items[i].kind === "text") return this.t.items[i].text;
    return null;
  }

  write(obj) {
    if (!this.proc) return false;
    try { writeProcess(this.proc, JSON.stringify(obj) + "\n"); return true; }
    catch { return false; }
  }

  // The next frame brings the bottom anchor (the scroll area's last child) into view.
  follow() { this.following = true; }

  send(cx) {
    const text = this.input.value().trim();
    if (!text) return;
    if (text === "/clear" || text === "/new") { this.input.set_value(""); this.restart(cx, null); return; }
    this.t.user(text);
    if (this.proc) this.write(userMessage(text));
    else {
      // Sent once claude is up (it may still be starting, or have stopped).
      this.queue.push(userMessage(text));
      if (!this.starting) this.start(cx, this.t.session);
    }
    this.input.set_value("");
    this.follow();
    cx.notify();
  }

  stop(cx) {
    for (const a of this.t.pending()) this.answer(a, "deny", undefined, cx);
    this.write(control({ subtype: "interrupt" }));
    cx.notify();
  }

  restart(cx, session) {
    if (this.proc) { const id = this.proc; this.proc = null; try { killProcess(id); } catch { /* gone */ } }
    this.t = new Transcript();
    this.open = new Set();
    if (!session) this.save();
    cx.spawn(async cx => { if (session) await this.restore(session); this.start(cx, session); cx.notify(); });
  }

  answer(ask, choice, input, cx) {
    if (ask.answered) return;
    ask.answered = choice;
    this.write(permissionReply(ask, choice, input));
    if (choice === "always" && ask.suggestions.some(s => s.type === "setMode")) {
      const m = ask.suggestions.find(s => s.type === "setMode").mode;
      if (MODES.some(x => x.id === m)) { this.mode = m; this.save(); }
    }
    cx.notify();
  }

  setModel(cx) {
    const i = MODELS.findIndex(m => m.id === this.model);
    this.model = MODELS[(i + 1) % MODELS.length].id;
    this.save();
    if (this.proc) this.write(control({ subtype: "set_model", model: this.model ?? "default" }));
    cx.notify();
  }

  setMode(cx) {
    const i = MODES.findIndex(m => m.id === this.mode);
    this.mode = MODES[(i + 1) % MODES.length].id;
    this.save();
    if (this.proc) this.write(control({ subtype: "set_permission_mode", mode: this.mode }));
    cx.notify();
  }

  toggle(i, cx) {
    if (this.open.has(i)) this.open.delete(i); else this.open.add(i);
    cx.notify();
  }

  // ---- drawing ----

  mono() { return settings().font_family ?? "JetBrains Mono"; }

  button(id, label, kind, action) {
    const t = theme();
    const primary = kind === "primary", danger = kind === "danger";
    return h_flex().id(id).h(28).px(12).items_center().rounded(7).flex_none()
      .border_1().border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : danger ? t.blocked : t.foreground).text_size(12).font_medium()
      .cursor_pointer().hover(s => s.opacity(0.85))
      .on_click((_e, cx) => action(cx)).child(label);
  }

  codeLines(lines, max) {
    const t = theme();
    const shown = max ? lines.slice(0, max) : lines;
    const color = (mark) => mark === "+" ? t.done : mark === "-" ? t.blocked : mark === "$" ? t.accent : t.muted;
    const bg = (mark) => mark === "+" ? tint(t.done, "22") : mark === "-" ? tint(t.blocked, "22") : t.background;
    return v_flex().w_full().rounded(6).bg(t.background).border_1().border_color(t.border).py(6).overflow_hidden()
      .font_family(this.mono()).text_size(11.5)
      .children(shown.map(l => h_flex().w_full().px(8).bg(bg(l.mark)).items_start()
        .child(div().w(14).flex_none().text_color(color(l.mark)).child(l.mark === " " ? "" : l.mark))
        .child(div().flex_1().min_w_0().text_color(t.foreground).child(l.text || " "))))
      .when(max && lines.length > max, el => el.child(div().px(8).pt(2).text_color(t.dim).child(`… ${lines.length - max} more lines`)));
  }

  userItem(item, i) {
    const t = theme();
    return h_flex().w_full().justify_end().pl(48)
      .child(div().max_w(680).px(14).py(9).rounded(14).bg(t.raised).border_1().border_color(t.border)
        .text_size(13.5).text_color(t.foreground)
        .child(TextView.markdown(`u${i}`, item.text).selectable(true)));
  }

  textItem(item, i) {
    const t = theme();
    return div().w_full().text_size(13.5).text_color(t.foreground)
      .child(TextView.markdown(`a${i}`, item.text || " ").selectable(true));
  }

  thinkingItem(item, i, cx) {
    const t = theme();
    const open = this.open.has(i);
    return v_flex().w_full().gap(4)
      .child(h_flex().id(`th${i}`).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.dim)
        .on_click((_e, cx) => this.toggle(i, cx))
        .child(svg(open ? "mods/chat/chevron-down.svg" : "mods/chat/chevron-right.svg").size(12).text_color(t.dim))
        .child(div().italic().child(item.streaming ? "Thinking…" : "Thought")))
      .when(open, el => el.child(div().pl(18).text_size(12.5).text_color(t.muted).italic()
        .child(TextView.markdown(`th-body${i}`, item.text).selectable(true))));
  }

  toolItem(item, i) {
    const t = theme();
    const open = this.open.has(i);
    const status = !item.done
      ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
      : div().size(7).rounded_full().bg(item.error ? t.blocked : item.result == null ? t.dim : t.done);
    const result = item.result ? item.result.split("\n").map(text => ({ mark: " ", text })) : null;
    return v_flex().w_full().gap(6)
      .child(h_flex().id(`tool${i}`).w_full().h(26).gap(8).px(8).items_center().rounded(7).cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggle(i, cx))
        .child(h_flex().w(14).justify_center().child(status))
        .child(div().flex_none().text_size(12.5).font_medium().text_color(t.foreground).child(item.name))
        .child(div().flex_1().min_w_0().truncate().text_size(12.5).text_color(t.muted).font_family(this.mono()).child(summary(item.name, item.input)))
        .child(svg(open ? "mods/chat/chevron-down.svg" : "mods/chat/chevron-right.svg").size(12).text_color(t.dim)))
      .when(open, el => el.child(v_flex().pl(30).gap(6)
        .child(this.codeLines(details(item.name, item.input), 60))
        .when(Boolean(result), el => el.child(div().text_size(11).text_color(item.error ? t.blocked : t.dim).child(item.error ? "Error" : "Result")))
        .when(Boolean(result), el => el.child(this.codeLines(result, RESULT_LINES * 3)))))
      .when(!open && item.error && Boolean(item.result), el => el.child(div().pl(30).text_size(12).text_color(t.blocked).truncate().child(item.result.split("\n")[0])));
  }

  askItem(item, i) {
    const t = theme();
    const live = !item.answered && Boolean(this.proc);
    const cardFrame = (el) => el.w_full().rounded(10).border_1().border_color(live ? t.blocked : t.border).bg(t.surface).p(12).gap(10);

    if (item.tool === "AskUserQuestion") {
      const questions = item.input.questions ?? [];
      item.picked ??= {};
      return cardFrame(v_flex())
        .children(questions.map((q, qi) => v_flex().gap(6)
          .child(div().text_size(13).font_medium().text_color(t.foreground).child(q.question))
          .child(h_flex().flex_wrap().gap(6).children((q.options ?? []).map((o, oi) => {
            const chosen = item.picked[q.question] === o.label;
            return v_flex().id(`q${i}-${qi}-${oi}`).px(10).py(6).rounded(8).border_1().max_w(320)
              .border_color(chosen ? t.accent : t.border).bg(chosen ? t.selected : t.raised).cursor_pointer()
              .when(live, el => el.hover(s => s.bg(t.hover)))
              .on_click((_e, cx) => { if (!live) return; item.picked[q.question] = o.label; cx.notify(); })
              .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
              .when(Boolean(o.description), el => el.child(div().text_size(11).text_color(t.dim).child(o.description)));
          })))))
        .when(live, el => el.child(h_flex().gap(8).justify_end()
          .child(this.button(`qs${i}-skip`, "Skip", "danger", cx => this.answer(item, "deny", undefined, cx)))
          .child(this.button(`qs${i}-ok`, "Answer", "primary", cx => this.answer(item, "allow", { ...item.input, answers: item.picked }, cx)))))
        .when(!live, el => el.child(div().text_size(11.5).text_color(t.dim).child(item.answered === "deny" ? "Skipped" : item.answered === "expired" ? "No longer waiting" : "Answered")));
    }

    if (item.tool === "ExitPlanMode") {
      return cardFrame(v_flex())
        .child(div().text_size(12).font_medium().text_color(t.dim).child("Plan"))
        .child(div().text_size(13.5).text_color(t.foreground).child(TextView.markdown(`plan${i}`, item.input.plan ?? "").selectable(true)))
        .when(live, el => el.child(h_flex().gap(8).justify_end()
          .child(this.button(`pl${i}-no`, "Keep planning", "danger", cx => this.answer(item, "deny", undefined, cx)))
          .child(this.button(`pl${i}-yes`, "Approve plan", "primary", cx => { this.mode = "default"; this.save(); this.answer(item, "allow", undefined, cx); }))))
        .when(!live, el => el.child(div().text_size(11.5).text_color(t.dim).child(item.answered === "deny" ? "Kept planning" : item.answered === "expired" ? "No longer waiting" : "Approved")));
    }

    const always = item.suggestions.length > 0;
    const verdict = { allow: "Allowed", always: "Allowed for this session", deny: "Denied", expired: "No longer waiting" }[item.answered];
    return cardFrame(v_flex())
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded_full().bg(live ? t.blocked : t.dim))
        .child(div().text_size(13).font_medium().text_color(t.foreground)
          .child(`Allow ${item.tool}${item.description && !["Bash", "PowerShell"].includes(item.tool) ? ` · ${item.description}` : ""}?`)))
      .when(["Bash", "PowerShell"].includes(item.tool) && Boolean(item.input.description), el => el.child(div().text_size(12).text_color(t.muted).child(item.input.description)))
      .when(Boolean(item.input.file_path), el => el.child(div().text_size(12).text_color(t.muted).font_family(this.mono()).child(item.input.file_path)))
      .child(this.codeLines(details(item.tool, item.input), 40))
      .when(live, el => el.child(h_flex().gap(8).justify_end()
        .child(this.button(`p${i}-deny`, "Deny", "danger", cx => this.answer(item, "deny", undefined, cx)))
        .when(always, el => el.child(this.button(`p${i}-always`, item.suggestions.some(s => s.type === "setMode") ? "Allow all edits" : "Always allow", null, cx => this.answer(item, "always", undefined, cx))))
        .child(this.button(`p${i}-allow`, "Allow", "primary", cx => this.answer(item, "allow", undefined, cx)))))
      .when(!live, el => el.child(div().text_size(11.5).text_color(item.answered === "deny" ? t.blocked : t.dim).child(verdict ?? "")));
  }

  noteItem(item) {
    const t = theme();
    return h_flex().w_full().justify_center()
      .child(div().text_size(11.5).text_color(item.level === "error" ? t.blocked : t.dim).child(item.text));
  }

  turnItem(item) {
    const t = theme();
    if (item.error) return div().w_full().text_size(12).text_color(t.blocked).child(`⚠ ${item.error}`);
    const bits = [item.ms != null ? `${(item.ms / 1000).toFixed(1)}s` : null].filter(Boolean);
    return bits.length ? div().w_full().text_size(10.5).text_color(t.dim).opacity(0.7).child(bits.join(" · ")) : div();
  }

  item(item, i, cx) {
    switch (item.kind) {
      case "user": return this.userItem(item, i);
      case "text": return this.textItem(item, i);
      case "thinking": return item.text?.trim() ? this.thinkingItem(item, i, cx) : null;
      case "tool": return this.toolItem(item, i);
      case "ask":
        // An allowed tool shows as its tool card; questions and plans stay readable.
        if ((item.answered === "allow" || item.answered === "always") && !["AskUserQuestion", "ExitPlanMode"].includes(item.tool)) return null;
        return this.askItem(item, i);
      case "note": return this.noteItem(item);
      case "turn": return this.turnItem(item);
    }
    return null;
  }

  empty() {
    const t = theme();
    return v_flex().w_full().pt(80).items_center().gap(10)
      .child(image("icons/claude.svg").size(36))
      .child(div().text_size(18).font_semibold().text_color(t.foreground).child("What should we work on?"))
      .child(div().text_size(12.5).text_color(t.dim).font_family(this.mono()).child(this.folder));
  }

  header() {
    const t = theme();
    const title = this.t.items.find(i => i.kind === "user")?.text.split("\n")[0] ?? "New chat";
    return h_flex().w_full().h(40).px(14).gap(10).items_center().flex_none().border_b_1().border_color(t.border).bg(t.chrome)
      .child(image("icons/claude.svg").size(16))
      .child(div().flex_1().min_w_0().truncate().text_size(13).font_medium().text_color(t.foreground).child(title))
      .child(div().max_w(260).truncate().text_size(11.5).text_color(t.dim).font_family(this.mono()).child(this.folder))
      .child(h_flex().id("chat-new").size(26).rounded(6).items_center().justify_center().cursor_pointer().tooltip("New chat")
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.restart(cx, null))
        .child(svg("mods/chat/plus.svg").size(14).text_color(t.muted)));
  }

  composer() {
    const t = theme();
    const busy = this.t.busy;
    const modelLabel = MODELS.find(m => m.id === this.model)?.label ?? this.model;
    const modeLabel = MODES.find(m => m.id === this.mode)?.label ?? this.mode;
    const chip = (id, label, tip, action, accent) => h_flex().id(id).h(24).px(8).gap(5).items_center().rounded(6).cursor_pointer()
      .text_size(11.5).text_color(accent ? t.accent : t.muted).hover(s => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => action(cx)).child(label);
    const canSend = Boolean(this.input.value().trim());
    const action = busy && !canSend
      ? h_flex().id("chat-stop").size(30).rounded(8).items_center().justify_center().bg(t.solid).cursor_pointer().tooltip("Stop")
        .on_click((_e, cx) => this.stop(cx)).child(svg("mods/chat/stop.svg").size(13).text_color(t.solid_foreground))
      : h_flex().id("chat-send").size(30).rounded(8).items_center().justify_center().bg(canSend ? t.solid : t.raised).cursor_pointer().tooltip("Send (Enter)")
        .on_click((_e, cx) => this.send(cx)).child(svg("mods/chat/send.svg").size(14).text_color(canSend ? t.solid_foreground : t.dim));
    return v_flex().w_full().px(16).pb(14).pt(6).flex_none()
      .when(Boolean(this.ended), el => el.child(h_flex().w_full().pb(8).gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(t.blocked).child(this.ended))
        .child(this.button("chat-restart", "Restart", null, cx => this.restart(cx, this.t.session)))))
      .child(v_flex().w_full().max_w(860).mx_auto().rounded(14).border_1().border_color(t.input).bg(t.surface).shadow_md()
        .child(div().px(14).pt(10).child(Textarea.new(this.input).w_full().text_size(13.5).text_color(t.foreground).border_0().bg(t.surface)))
        .child(h_flex().px(8).pb(8).pt(4).gap(2).items_center()
          .child(chip("chat-mode", modeLabel, "Permission mode (click to change)", cx => this.setMode(cx), this.mode !== "default"))
          .child(chip("chat-model", modelLabel, "Model (click to change)", cx => this.setModel(cx), false))
          .child(div().flex_1())
          .when(busy, el => el.child(h_flex().gap(6).items_center().pr(8).text_size(11.5).text_color(t.working)
            .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))
            .child(this.t.pending().length ? "Waiting for you" : "Working")))
          .child(action)));
  }

  render(cx) {
    const t = theme();
    const rows = this.t.items.map((it, i) => this.item(it, i, cx)).filter(Boolean)
      .map(row => div().w_full().max_w(860).flex_none().child(row));
    if (rows.length === 0 && !this.ended) rows.push(this.empty());
    rows.push(div().id("chat-bottom").h(1).w_full().flex_none());
    if (this.following) { this.following = false; this.scroll.scroll_to_item(rows.length - 1); }
    return v_flex().id("chat").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(this.header())
      .child(v_flex().id("chat-scroll").flex_1().min_h(0).w_full().overflow_y_scrollbar().track_scroll(this.scroll)
        .items_center().px(20).pt(18).pb(6).gap(14)
        .children(rows))
      .child(this.composer());
  }
}
