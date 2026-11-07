// Events the backend pushes to the 3D page, and messages the page sends back.
// Shared by server and (by convention) public/index.html.

export type WorkerInfo = { id: string; name: string; role: string; color: string; desk: number };

export type ServerEvent =
  | { type: "hello"; mode: "live" | "mock"; model: string; workers: WorkerInfo[] }
  | { type: "task_received"; taskId: string; text: string }
  | { type: "delegate"; taskId: string; subId: string; worker: string; instruction: string }
  | { type: "worker_step"; subId: string; worker: string; label: string; kind: string }
  | { type: "worker_done"; subId: string; worker: string; summary: string; ok: boolean }
  | { type: "need_approval"; approvalId: string; worker: string; tool: string; summary: string }
  | { type: "approval_result"; approvalId: string; approved: boolean }
  | { type: "manager_reply"; taskId: string; text: string }
  | { type: "error"; taskId?: string; message: string };

export type ClientMessage =
  | { type: "task"; text: string; target?: string }
  | { type: "approve"; approvalId: string; approved: boolean };
