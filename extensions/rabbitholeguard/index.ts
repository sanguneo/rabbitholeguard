/** Optional, session-local evidence guard. This observes tools, not code state. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends ToolCallEvent {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details?: unknown;
  isError: boolean;
}

export interface GuardContext {
  hasUI: boolean;
  ui: { notify(message: string, level: "info" | "warning"): void };
}

export interface GuardEvents {
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  input: { source: string };
  session_start: { reason?: string };
  session_shutdown: { reason?: string };
}

/** Minimal structural subset of the public Senpi extension API; no runtime import. */
export interface GuardAPI {
  on<K extends keyof GuardEvents>(
    name: K,
    handler: (event: GuardEvents[K], ctx: GuardContext) => unknown,
  ): void;
  registerCommand(name: string, options: {
    description: string;
    handler: (args: string, ctx: GuardContext) => Promise<void>;
  }): void;
}

/** Explicit exact verification commands. Configuration never enables the guard. */
export interface GuardOptions {
  commands?: readonly string[];
}

const MAX_COMMANDS = 128;
const MAX_COMMAND_LENGTH = 8192;
const MAX_PENDING = 256;
const mutations = new Set(["write", "edit", "apply_patch"]);

type Pending = {
  toolName: string;
  epoch: number;
} & ({ kind: "verification"; command: string } | { kind: "mutation" | "environment" });

function backgroundResult(event: ToolResultEvent): boolean {
  if (event.details && typeof event.details === "object" && "bash_id" in event.details) {
    return true;
  }
  // Some shell adapters expose their launch handle only in textual JSON/results.
  return event.content.some((part) =>
    part.type === "text" && /\bbash_id\b/.test(part.text ?? ""),
  );
}

/** Register lifecycle handlers and the user-only /rabbitholeguard command. */
export default function rabbitholeguard(pi: GuardAPI, options: GuardOptions = {}): void {
  const configured = new Set<string>();
  for (const raw of options.commands ?? []) {
    const command = raw.trim();
    if (command && command.length <= MAX_COMMAND_LENGTH && configured.size < MAX_COMMANDS) {
      configured.add(command);
    }
  }
  let watched = new Set(configured);
  let enabled = false;
  let allowOnce = false;
  let epoch = 0;
  const counts = new Map<string, number>();
  const pending = new Map<string, Pending>();

  const invalidate = () => {
    epoch++;
    counts.clear();
  };
  const clearEvidence = () => {
    invalidate();
    pending.clear();
    allowOnce = false;
  };
  const resetSession = () => {
    enabled = false;
    watched = new Set(configured);
    clearEvidence();
  };
  const notify = (ctx: GuardContext, message: string, level: "info" | "warning" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  pi.on("session_start", resetSession);
  pi.on("session_shutdown", resetSession);
  pi.on("input", (event) => {
    if (event.source !== "extension") clearEvidence();
  });

  pi.registerCommand("rabbitholeguard", {
    description: "Session verification guard: on, off, status, reset, allow-once, watch <exact command>",
    handler: async (args, ctx) => {
      const value = args.trim();
      const watch = /^watch\s+([\s\S]+)$/.exec(value);
      if (watch) {
        const command = watch[1].trim();
        if (command.length > MAX_COMMAND_LENGTH || (!watched.has(command) && watched.size >= MAX_COMMANDS)) {
          notify(ctx, "rabbitholeguard: watch limit is 128 commands of at most 8192 characters.", "warning");
          return;
        }
        watched.add(command);
        enabled = true;
        clearEvidence();
        notify(ctx, `rabbitholeguard: watching exact command ${JSON.stringify(command)}; on.`);
        return;
      }
      switch (value || "status") {
        case "on":
          enabled = true;
          clearEvidence();
          break;
        case "off":
          enabled = false;
          clearEvidence();
          break;
        case "reset":
          clearEvidence();
          break;
        case "allow-once":
          allowOnce = true;
          break;
        case "status":
          break;
        default:
          notify(ctx, "Usage: /rabbitholeguard on|off|status|reset|allow-once|watch <exact command>", "warning");
          return;
      }
      notify(ctx, `rabbitholeguard: ${enabled ? "on" : "off"}; ${watched.size} exact commands watched; `
        + `${counts.size} commands with completed evidence; allow-once ${allowOnce ? "armed" : "off"}.`);
    },
  });

  pi.on("tool_call", (event) => {
    if (!enabled) return;
    let item: Pending;
    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command.trim() : undefined;
      if (command !== undefined && watched.has(command)) {
        if ((counts.get(command) ?? 0) >= 2) {
          if (!allowOnce) {
            return {
              block: true,
              reason: "rabbitholeguard: two identical completed verification runs were observed "
                + "without an intervening observed successful mutation. Change something, or ask "
                + "the user to use /rabbitholeguard allow-once.",
            };
          }
          allowOnce = false;
        }
        item = { toolName: event.toolName, command, epoch, kind: "verification" };
      } else {
        // Unknown shell commands can change the environment even when they fail.
        invalidate();
        item = { toolName: event.toolName, epoch, kind: "environment" };
      }
    } else if (mutations.has(event.toolName)) {
      item = { toolName: event.toolName, epoch, kind: "mutation" };
    } else {
      return;
    }
    if (pending.size >= MAX_PENDING || pending.has(event.toolCallId)) {
      // Lost correlation is not evidence. Fail open, with bounded storage.
      clearEvidence();
      return;
    }
    pending.set(event.toolCallId, item);
  });

  pi.on("tool_result", (event) => {
    const item = pending.get(event.toolCallId);
    if (!enabled || !item || item.toolName !== event.toolName) return;
    // A mismatched input must not complete a different pending verification.
    if (item.kind === "verification"
      && (typeof event.input.command !== "string" || event.input.command.trim() !== item.command)) return;
    pending.delete(event.toolCallId);
    if (item.kind === "environment") {
      invalidate();
      return;
    }
    if (item.kind === "mutation") {
      if (!event.isError) invalidate();
      return;
    }
    if (item.epoch !== epoch || backgroundResult(event)) return;
    // Do not assert unchanged state while a mutating operation is still running.
    if ([...pending.values()].some((value) => value.kind !== "verification")) return;
    const command = item.command;
    const previous = counts.get(command) ?? 0;
    counts.set(command, Math.min(2, previous + 1));
    if (previous !== 1) return;
    return {
      content: [...event.content, {
        type: "text",
        text: "\n[rabbitholeguard] Second identical completed verification run observed without "
          + "an intervening observed successful mutation. The next identical run will be blocked. "
          + "This is tool evidence, not proof that code or external state is unchanged.",
      }],
    };
  });
}
