import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type WorkerDef = {
  id: string;
  name: string;
  role: string;
  color: string;
  desk: number; // 0..5, which desk in the 3D office
  tools: string[]; // pi tool allowlist
  customTools: ToolDefinition[];
  prompt: string;
};

/** Read-only web fetch: GET a URL and return readable text (capped). */
const fetchUrl: ToolDefinition = {
  name: "fetch_url",
  label: "Fetch URL",
  description: "下载一个网页（HTTP GET），返回去掉 HTML 标签后的正文文本，最多约 8000 字。只读，不会提交任何数据。",
  parameters: Type.Object({ url: Type.String({ description: "完整的 http(s) 网址" }) }),
  async execute(_id, params: any, signal) {
    const url = String(params.url);
    if (!/^https?:\/\//i.test(url)) return { content: [{ type: "text", text: "只支持 http(s) 网址" }], details: {}, isError: true } as any;
    const res = await fetch(url, { signal, headers: { "user-agent": "pi-office/0.1" }, redirect: "follow" });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);
    return { content: [{ type: "text", text: `HTTP ${res.status} ${url}\n\n${text}` }], details: { status: res.status } };
  },
};

const COMMON = `你是“工位小队”里的一名员工，经理会给你派活。
- 只在工作目录里操作文件，不要碰工作目录以外的路径。
- 写入、修改文件会先请用户确认；如果被拒绝，就换个做法或说明情况，不要反复尝试同一个操作。
- 做完后用中文给经理一段简短的汇报：做了什么、结果在哪、有没有问题。`;

export const ROSTER: WorkerDef[] = [
  {
    id: "files",
    name: "理理",
    role: "文件",
    color: "#6b4fe0",
    desk: 2,
    tools: ["read", "ls", "find", "grep", "write", "edit"],
    customTools: [],
    prompt: `${COMMON}\n你的专长：整理、查找、阅读和编写本地文件。`,
  },
  {
    id: "web",
    name: "查查",
    role: "情报",
    color: "#e8b40c",
    desk: 4,
    tools: ["fetch_url", "read", "write"],
    customTools: [fetchUrl],
    prompt: `${COMMON}\n你的专长：上网查资料。用 fetch_url 读取网页，提炼要点；需要时把整理结果写成文件。`,
  },
];

export const MANAGER_PROMPT = (roster: WorkerDef[]) => `你是“工位小队”的经理。用户给你下任务，你负责理解、拆分，并用 delegate 工具派给合适的员工，最后把结果汇总给用户。

员工：
${roster.map((w) => `- ${w.id}（${w.name}，${w.role}）`).join("\n")}

规则：
- 你自己不能直接操作文件或上网，必须通过 delegate 派活。
- 交代任务要具体：要做什么、产出放哪、注意什么。
- 互不依赖的子任务可以在同一轮里同时派给不同员工。
- 如果用户点名要某位员工，就派给他。
- 所有员工都汇报后，用中文给用户一段简短的总结。闲聊或不需要干活的问题可以直接回答。`;
