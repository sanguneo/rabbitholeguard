import { describe, expect, test } from "bun:test";
import rabbitholeguard, {
  type GuardAPI,
  type GuardContext,
  type GuardEvents,
  type GuardOptions,
  type ToolCallEvent,
  type ToolResultEvent,
} from "../extensions/rabbitholeguard";

function harness(options: GuardOptions = {}) {
  const handlers: {
    [K in keyof GuardEvents]: Array<(event: GuardEvents[K], ctx: GuardContext) => unknown>;
  } = { tool_call: [], tool_result: [], input: [], session_start: [], session_shutdown: [] };
  const commands = new Map<string, (args: string, ctx: GuardContext) => Promise<void>>();
  const notices: string[] = [];
  const ctx: GuardContext = {
    hasUI: true,
    ui: { notify: (message) => { notices.push(message); } },
  };
  const api: GuardAPI = {
    on: (name, handler) => {
      handlers[name].push(handler);
    },
    registerCommand: (name, { handler }) => { commands.set(name, handler); },
  };
  rabbitholeguard(api, options);
  let id = 0;
  async function emit<K extends keyof GuardEvents>(name: K, event: GuardEvents[K]) {
    let result: unknown;
    for (const handler of handlers[name]) {
      const patch = await handler(event, ctx);
      if (patch !== undefined) result = patch;
      if (name === "tool_result" && patch) Object.assign(event, patch);
    }
    return result;
  }
  async function call(toolName = "bash", input: Record<string, unknown> = { command: "bun test" }) {
    const event: ToolCallEvent = { toolName, input, toolCallId: `call-${++id}` };
    const response = await emit("tool_call", event);
    const gate = response && typeof response === "object" && "block" in response
      && response.block === true && "reason" in response && typeof response.reason === "string"
      ? { block: true, reason: response.reason } : undefined;
    return { event, gate };
  }
  async function result(call: Awaited<ReturnType<typeof call>>, extra: Partial<ToolResultEvent> = {}) {
    // Blocked executions still produce a real error result with the same ID.
    const event: ToolResultEvent = {
      ...call.event,
      content: [{ type: "text", text: call.gate?.block ? call.gate.reason : "real output" }],
      details: { exitCode: call.gate?.block ? 1 : 0 },
      isError: !!call.gate?.block,
      ...extra,
    };
    await emit("tool_result", event);
    return event;
  }
  async function run(command = "bun test", extra: Partial<ToolResultEvent> = {}) {
    const invocation = await call("bash", { command });
    return { ...invocation, result: await result(invocation, extra) };
  }
  return { emit, call, result, run, notices, commands,
    command: (args: string) => {
      const handler = commands.get("rabbitholeguard");
      if (!handler) throw new Error("Missing extension command");
      return handler(args, ctx);
    } };
}

describe("optional rabbitholeguard extension", () => {
  test("is off even with explicit configuration and registers only a slash command", async () => {
    const h = harness({ commands: ["bun test"] });
    expect([...h.commands.keys()]).toEqual(["rabbitholeguard"]);
    for (let i = 0; i < 4; i++) expect((await h.run()).gate).toBeUndefined();
    await h.command("status");
    expect(h.notices.at(-1)).toContain("off; 1 exact commands");
    await h.command("on");
    expect((await h.run()).result.content).toHaveLength(1);
    expect((await h.run()).result.content).toHaveLength(2);
    expect((await h.run()).gate?.block).toBe(true);
  });

  test("warns in the real second result, preserves errors and details, then blocks", async () => {
    const h = harness();
    await h.command("watch bun test");
    await h.run();
    const second = await h.run("bun test", {
      isError: true, details: { exitCode: 1 }, content: [{ type: "text", text: "real failure" }],
    });
    expect(second.result.isError).toBe(true);
    expect(second.result.details).toEqual({ exitCode: 1 });
    expect(second.result.content[0].text).toBe("real failure");
    expect(second.result.content[1].text).toContain("Second identical");
    const third = await h.run();
    expect(third.gate?.block).toBe(true);
    expect(third.result.isError).toBe(true);
    expect(third.result.content).toHaveLength(1);
    await h.command("allow-once");
    expect((await h.run()).gate).toBeUndefined();
    expect((await h.run()).gate?.block).toBe(true);
    await h.command("off");
    expect((await h.run()).gate).toBeUndefined();
    await h.command("on");
    expect((await h.run()).result.content).toHaveLength(1);
  });

  test("compares trimmed exact strings while preserving quoted whitespace", async () => {
    const h = harness();
    await h.command('watch  bun test --name "a  b"  ');
    const command = 'bun test --name "a  b"';
    await h.run(`  ${command}  `);
    await h.run(command);
    expect((await h.run(command)).gate?.block).toBe(true);
    expect((await h.run('bun test --name "a b"')).gate).toBeUndefined();
    expect((await h.run(command)).result.content).toHaveLength(1);
  });

  test("on does not guess verification commands and unknown commands remain allowed", async () => {
    const h = harness();
    await h.command("on");
    for (let i = 0; i < 4; i++) expect((await h.run()).gate).toBeUndefined();
    await h.command("watch bun test");
    await h.run();
    await h.run();
    await h.run("export CHANGED=1", { isError: true });
    expect((await h.run()).result.content).toHaveLength(1);
    await h.command("protect .env");
    expect(h.notices.at(-1)).toContain("Usage:");
  });

  test.each(["write", "edit", "apply_patch"])("successful %s invalidates evidence, failure does not", async (tool) => {
    const h = harness();
    await h.command("watch bun test");
    await h.run();
    await h.run();
    const failed = await h.call(tool, { path: "file.ts" });
    await h.result(failed, { isError: true });
    expect((await h.run()).gate?.block).toBe(true);
    const changed = await h.call(tool, { path: "file.ts" });
    await h.result(changed);
    expect((await h.run()).result.content).toHaveLength(1);
  });

  test("input resets evidence for user requests but not extension messages", async () => {
    const h = harness();
    await h.command("watch bun test");
    await h.run();
    await h.run();
    await h.emit("input", { source: "extension" });
    expect((await h.run()).gate?.block).toBe(true);
    await h.emit("input", { source: "interactive" });
    expect((await h.run()).result.content).toHaveLength(1);
    await h.run();
    await h.emit("input", { source: "rpc" });
    expect((await h.run()).result.content).toHaveLength(1);
    await h.command("reset");
    expect((await h.run()).result.content).toHaveLength(1);
  });

  test.each(["startup", "new", "resume", "fork", "reload"])("session_start %s clears evidence and returns to off", async (reason) => {
    const h = harness({ commands: ["bun test"] });
    await h.command("watch other test");
    await h.run("other test");
    await h.run("other test");
    await h.emit("session_start", { reason });
    await h.command("status");
    expect(h.notices.at(-1)).toContain("off; 1 exact commands");
    await h.command("on");
    for (let i = 0; i < 3; i++) expect((await h.run("other test")).gate).toBeUndefined();
    await h.run();
    await h.run();
    expect((await h.run()).gate?.block).toBe(true);
    await h.emit("session_shutdown", {});
    expect((await h.run()).gate).toBeUndefined();
  });

  test("counts completed concurrent calls in completion order, not launches", async () => {
    const h = harness();
    await h.command("watch bun test");
    const a = await h.call();
    const b = await h.call();
    const c = await h.call();
    expect(c.gate).toBeUndefined();
    expect((await h.result(b)).content).toHaveLength(1);
    expect((await h.result(a)).content).toHaveLength(2);
    expect((await h.call()).gate?.block).toBe(true);
    expect((await h.result(c)).content).toHaveLength(1);
    expect((await h.result(b)).content).toHaveLength(1);
  });

  test("requires matching IDs, tool names, and exact result input", async () => {
    const h = harness();
    await h.command("watch bun test");
    const a = await h.call();
    await h.result(a, { toolCallId: "unknown" });
    await h.result(a, { toolName: "read" });
    await h.result(a, { input: { command: "other" } });
    expect((await h.result(a)).content).toHaveLength(1);
    expect((await h.run()).result.content).toHaveLength(2);
    expect((await h.run()).gate?.block).toBe(true);
  });

  test("ignores stale verification completions and completions during pending mutations", async () => {
    const h = harness();
    await h.command("watch bun test");
    const old = await h.call();
    const write = await h.call("write", { path: "file.ts" });
    expect((await h.result(old)).content).toHaveLength(1);
    const stale = await h.call();
    await h.result(write);
    expect((await h.result(stale)).content).toHaveLength(1);
    expect((await h.run()).result.content).toHaveLength(1);
    const environment = await h.call("bash", { command: "touch file.ts" });
    const concurrent = await h.call();
    expect((await h.result(concurrent)).content).toHaveLength(1);
    await h.result(environment);
    expect((await h.run()).result.content).toHaveLength(1);
  });

  test("reset/off discards pending calls, and unrelated tools do not invalidate", async () => {
    const h = harness();
    await h.command("watch bun test");
    const old = await h.call();
    await h.command("reset");
    await h.result(old);
    await h.run();
    const read = await h.call("read", { path: "file.ts" });
    await h.result(read);
    expect((await h.run()).result.content).toHaveLength(2);
    expect((await h.run()).gate?.block).toBe(true);
    const blocked = await h.call();
    await h.command("reset");
    await h.result(blocked);
    expect((await h.run()).result.content).toHaveLength(1);
  });

  test("background launch handles never count as completed verification", async () => {
    const h = harness();
    await h.command("watch bun test");
    for (let i = 0; i < 4; i++) {
      const launch = await h.run("bun test", { details: { bash_id: `job-${i}` } });
      expect(launch.gate).toBeUndefined();
      expect(launch.result.content).toHaveLength(1);
    }
    await h.run("bun test", { content: [{ type: "text", text: '{"bash_id":"job"}' }] });
    expect((await h.run()).result.content).toHaveLength(1);
    expect((await h.run()).result.content).toHaveLength(2);
  });

  test("bounds pending correlation and watch configuration without failing closed", async () => {
    const h = harness();
    await h.command("watch bun test");
    for (let i = 0; i < 257; i++) expect((await h.call()).gate).toBeUndefined();
    expect((await h.run()).result.content).toHaveLength(1);
    await h.command(`watch ${"a".repeat(8193)}`);
    expect(h.notices.at(-1)).toContain("watch limit");
    for (let i = 0; i < 127; i++) await h.command(`watch command-${i}`);
    await h.command("watch overflow");
    expect(h.notices.at(-1)).toContain("watch limit");
  });
});
