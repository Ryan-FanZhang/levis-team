import { EventEmitter } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ServerEvent } from "./events.ts";
import { MANAGER_PROMPT, type WorkerDef } from "./roster.ts";

type Model = NonNullable<Parameters<typeof createAgentSession>[0]>["model"];

const NEEDS_APPROVAL = new Set(["write", "edit", "bash"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);

export type OfficeOptions = {
  modelRuntime: ModelRuntime;
  managerModel: Model;
  workerModel: Model;
  workspace: string;
  roster: WorkerDef[];
};

type Pending = { resolve: (ok: boolean) => void; event: Extract<ServerEvent, { type: "need_approval" }> };

/**
 * The office: one manager session that can only delegate, plus one pi session per worker.
 * Everything that happens is emitted as a ServerEvent ("event") for the 3D page.
 */
export class Office extends EventEmitter {
  private manager!: AgentSession;
  private workers = new Map<string, { def: WorkerDef; session: AgentSession; chain: Promise<unknown> }>();
  private managerChain: Promise<unknown> = Promise.resolve();
  private currentTaskId = "";
  private approvals = new Map<string, Pending>();

  constructor(private opts: OfficeOptions) {
    super();
  }

  private emitEvent(e: ServerEvent) {
    this.emit("event", e);
  }

  pendingApprovals() {
    return [...this.approvals.values()].map((p) => p.event);
  }

  private async makeLoader(systemPrompt: string, extensionFactories: any[] = []) {
    const loader = new DefaultResourceLoader({
      cwd: this.opts.workspace,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
      extensionFactories,
    });
    await loader.reload();
    return loader;
  }

  async init() {
    const { roster, workspace, modelRuntime } = this.opts;

    for (const def of roster) {
      const guard = (pi: any) => {
        pi.on("tool_call", async (event: any) => {
          // keep file tools inside the workspace
          if (PATH_TOOLS.has(event.toolName) && typeof event.input?.path === "string") {
            const abs = path.resolve(workspace, event.input.path);
            const rel = path.relative(workspace, abs);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
              return { block: true, reason: `路径 ${event.input.path} 在工作目录之外，不允许访问。` };
            }
          }
          if (NEEDS_APPROVAL.has(event.toolName)) {
            const ok = await this.requestApproval(def, event.toolName, event.input);
            if (!ok) return { block: true, reason: "用户拒绝了这个操作。" };
          }
          return undefined;
        });
      };
      const { session } = await createAgentSession({
        cwd: workspace,
        model: this.opts.workerModel,
        modelRuntime,
        thinkingLevel: "off",
        resourceLoader: await this.makeLoader(def.prompt, [guard]),
        sessionManager: SessionManager.inMemory(workspace),
        settingsManager: SettingsManager.inMemory({}),
        tools: def.tools,
        customTools: def.customTools,
      });
      session.subscribe((e: any) => {
        if (e.type === "tool_execution_start") {
          const sub = this.activeSub.get(def.id);
          if (sub) this.emitEvent({ type: "worker_step", subId: sub, worker: def.id, ...describeStep(e.toolName, e.args ?? {}) });
        }
      });
      this.workers.set(def.id, { def, session, chain: Promise.resolve() });
    }

    const delegate: ToolDefinition = {
      name: "delegate",
      label: "Delegate",
      description: "把一个子任务交给一位员工去做，等他完成后返回他的汇报。",
      parameters: Type.Object({
        worker: Type.Union(roster.map((w) => Type.Literal(w.id)), { description: "员工 id" }),
        task: Type.String({ description: "交代给员工的具体任务" }),
      }),
      execute: async (_id, params: any) => {
        const text = await this.runWorker(String(params.worker), String(params.task));
        return { content: [{ type: "text", text }], details: {} };
      },
    };
    const { session } = await createAgentSession({
      cwd: workspace,
      model: this.opts.managerModel,
      modelRuntime,
      thinkingLevel: "off",
      resourceLoader: await this.makeLoader(MANAGER_PROMPT(roster)),
      sessionManager: SessionManager.inMemory(workspace),
      settingsManager: SettingsManager.inMemory({}),
      tools: ["delegate"],
      customTools: [delegate],
    });
    this.manager = session;
  }

  private activeSub = new Map<string, string>();

  /** Run one sub-task on a worker; calls to the same worker queue up. */
  private runWorker(workerId: string, instruction: string): Promise<string> {
    const w = this.workers.get(workerId);
    if (!w) return Promise.resolve(`没有 id 为 ${workerId} 的员工。`);
    const taskId = this.currentTaskId;
    const run = async () => {
      const subId = randomUUID().slice(0, 8);
      this.activeSub.set(workerId, subId);
      this.emitEvent({ type: "delegate", taskId, subId, worker: workerId, instruction });
      try {
        await w.session.prompt(instruction);
        const summary = w.session.getLastAssistantText() || "（没有汇报）";
        this.emitEvent({ type: "worker_done", subId, worker: workerId, summary, ok: true });
        return summary;
      } catch (err) {
        const msg = `出错了：${(err as Error).message}`;
        this.emitEvent({ type: "worker_done", subId, worker: workerId, summary: msg, ok: false });
        return msg;
      } finally {
        this.activeSub.delete(workerId);
      }
    };
    const p = w.chain.then(run, run);
    w.chain = p;
    return p;
  }

  /** Queue a user task on the manager. */
  submit(text: string, target?: string) {
    const taskId = randomUUID().slice(0, 8);
    this.emitEvent({ type: "task_received", taskId, text });
    const def = target ? this.workers.get(target)?.def : undefined;
    const prompt = def ? `（用户指定由 ${def.id}/${def.name} 来做）\n${text}` : text;
    const run = async () => {
      this.currentTaskId = taskId;
      try {
        await this.manager.prompt(prompt);
        this.emitEvent({ type: "manager_reply", taskId, text: this.manager.getLastAssistantText() || "（经理没有回复）" });
      } catch (err) {
        this.emitEvent({ type: "error", taskId, message: (err as Error).message });
      }
    };
    this.managerChain = this.managerChain.then(run, run);
    return taskId;
  }

  private requestApproval(def: WorkerDef, tool: string, input: any): Promise<boolean> {
    const approvalId = randomUUID().slice(0, 8);
    const p = typeof input?.path === "string" ? input.path : "";
    const summary =
      tool === "write" ? `写入文件 ${p}（${String(input?.content ?? "").length} 字）`
      : tool === "edit" ? `修改文件 ${p}`
      : tool === "bash" ? `执行命令：${String(input?.command ?? "").slice(0, 120)}`
      : `${tool} ${p}`;
    const event = { type: "need_approval" as const, approvalId, worker: def.id, tool, summary };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolveApproval(approvalId, false), 10 * 60_000);
      this.approvals.set(approvalId, { event, resolve: (ok) => { clearTimeout(timer); resolve(ok); } });
      this.emitEvent(event);
    });
  }

  resolveApproval(approvalId: string, approved: boolean) {
    const p = this.approvals.get(approvalId);
    if (!p) return;
    this.approvals.delete(approvalId);
    this.emitEvent({ type: "approval_result", approvalId, approved });
    p.resolve(approved);
  }

  dispose() {
    for (const p of this.approvals.values()) p.resolve(false);
    this.manager?.dispose();
    for (const w of this.workers.values()) w.session.dispose();
  }
}

function describeStep(tool: string, args: any): { label: string; kind: string } {
  const p = typeof args.path === "string" ? args.path : ".";
  switch (tool) {
    case "read": return { label: `读取 ${p}`, kind: "doc" };
    case "ls": return { label: `查看目录 ${p}`, kind: "files" };
    case "find": return { label: `查找 ${args.pattern ?? ""}`, kind: "files" };
    case "grep": return { label: `搜索“${args.pattern ?? ""}”`, kind: "files" };
    case "write": return { label: `写入 ${p}`, kind: "doc" };
    case "edit": return { label: `修改 ${p}`, kind: "doc" };
    case "fetch_url": {
      let host = String(args.url ?? "");
      try { host = new URL(host).host; } catch {}
      return { label: `打开 ${host}`, kind: "feed" };
    }
    default: return { label: tool, kind: "term" };
  }
}
