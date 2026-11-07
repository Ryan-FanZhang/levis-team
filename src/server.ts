import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Office } from "./office.ts";
import { ROSTER } from "./roster.ts";
import { createMockProvider } from "./mock.ts";
import type { ClientMessage, ServerEvent } from "./events.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 5180);
const MOCK = process.argv.includes("--mock");
const WORKSPACE = path.resolve(process.env.OFFICE_WORKSPACE ?? path.join(ROOT, "workspace"));
fs.mkdirSync(WORKSPACE, { recursive: true });

// ---------- model ----------
const modelRuntime = await ModelRuntime.create();
let model;
if (MOCK) {
  modelRuntime.registerNativeProvider(createMockProvider().provider);
  model = modelRuntime.getModel("mock", "office-mock");
} else if (process.env.OFFICE_MODEL) {
  const [provider, ...rest] = process.env.OFFICE_MODEL.split("/");
  model = modelRuntime.getModel(provider, rest.join("/"));
  if (!model) throw new Error(`找不到模型 ${process.env.OFFICE_MODEL}`);
} else {
  const available = await modelRuntime.getAvailable();
  const preferred = ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5"];
  model = preferred.map((p) => available.find((m) => `${m.provider}/${m.id}` === p)).find(Boolean) ?? available[0];
}
if (!model) {
  console.error(
    "没有可用的模型。三选一：\n" +
      "  1. 设置环境变量，如 ANTHROPIC_API_KEY / OPENAI_API_KEY，再 npm start\n" +
      "  2. 先运行 `npx pi` 并在里面 /login 登录\n" +
      "  3. 用 npm run mock 跑模拟模式（不需要 key）",
  );
  process.exit(1);
}
const workerModel = process.env.OFFICE_WORKER_MODEL
  ? modelRuntime.getModel(process.env.OFFICE_WORKER_MODEL.split("/")[0], process.env.OFFICE_WORKER_MODEL.split("/").slice(1).join("/")) ?? model
  : model;

const office = new Office({ modelRuntime, managerModel: model, workerModel, workspace: WORKSPACE, roster: ROSTER });
await office.init();

// ---------- http + websocket ----------
const indexPath = path.join(ROOT, "public", "index.html");
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    fs.createReadStream(indexPath).pipe(res);
  } else {
    res.writeHead(404).end();
  }
});

const allowedOrigins = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const wss = new WebSocketServer({
  server,
  // only the page served by this process may connect (stops other websites from driving your agents)
  verifyClient: ({ origin }: { origin?: string }) => !!origin && allowedOrigins.has(origin),
});

const hello: ServerEvent = {
  type: "hello",
  mode: MOCK ? "mock" : "live",
  model: `${model.provider}/${model.id}`,
  workers: ROSTER.map(({ id, name, role, color, desk }) => ({ id, name, role, color, desk })),
};

const send = (ws: WebSocket, e: ServerEvent) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(e));
office.on("event", (e: ServerEvent) => {
  console.log("→", e.type, "worker" in e ? e.worker : "", "label" in e ? e.label : "", "summary" in e ? e.summary : "");
  for (const ws of wss.clients) send(ws, e);
});

wss.on("connection", (ws) => {
  send(ws, hello);
  for (const a of office.pendingApprovals()) send(ws, a);
  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "task" && typeof msg.text === "string" && msg.text.trim()) office.submit(msg.text.trim().slice(0, 2000), msg.target || undefined);
    if (msg.type === "approve" && typeof msg.approvalId === "string") office.resolveApproval(msg.approvalId, !!msg.approved);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`工位小队已启动：http://localhost:${PORT}  (${hello.type === "hello" ? hello.mode : ""}, 模型 ${model.provider}/${model.id})`);
  console.log(`工作目录：${WORKSPACE}`);
});

const shutdown = () => { office.dispose(); server.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
