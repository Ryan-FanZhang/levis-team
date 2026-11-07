// Scripted "faux" model so the whole pipeline (delegation, tools, approvals, UI) runs without an API key.
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: any): string =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

export function createMockProvider() {
  const faux = fauxProvider({ provider: "mock", models: [{ id: "office-mock", name: "Mock (no API key)" }], tokensPerSecond: 60 });

  const respond = async (ctx: any) => {
    const msgs: any[] = ctx.messages;
    const sys = JSON.stringify(msgs.filter((m) => m.role === "system"));
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
    const userText = textOf(msgs[lastUserIdx]);
    const since = msgs.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
    const last = msgs[msgs.length - 1];
    await sleep(700);

    // ---- manager ----
    if (sys.includes("delegate")) {
      if (last.role === "user") {
        const wantsWeb = /查|网|新闻|资料|搜|情报|example/i.test(userText) || userText.includes("web/");
        const wantsFiles = /文件|整理|写|笔记|目录|清单/.test(userText) || userText.includes("files/");
        const calls = [];
        if (wantsWeb) calls.push(fauxToolCall("delegate", { worker: "web", task: `上网查一下：${userText}，把要点汇报给我。` }));
        if (wantsFiles || !wantsWeb) calls.push(fauxToolCall("delegate", { worker: "files", task: `处理这件事：${userText}。看看工作目录里有什么，整理一份清单写到 整理清单.md。` }));
        return fauxAssistantMessage([fauxText("好，我来安排。"), ...calls], { stopReason: "toolUse" });
      }
      const reports = since.map((m) => "· " + textOf(m).split("\n")[0]).join("\n");
      return fauxAssistantMessage(`都办完了：\n${reports}\n（这是模拟模式的回复，接上真实模型后会是真正的总结。）`);
    }

    // ---- web worker ----
    if (sys.includes("fetch_url")) {
      if (since.length === 0) return fauxAssistantMessage([fauxToolCall("fetch_url", { url: "https://example.com" })], { stopReason: "toolUse" });
      const r = textOf(since[0]);
      return fauxAssistantMessage(`查了 example.com：${r.slice(0, 60).replace(/\s+/g, " ")}…（模拟汇报）`);
    }

    // ---- files worker ----
    if (since.length === 0) return fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
    if (since.length === 1) {
      const listing = textOf(since[0]);
      return fauxAssistantMessage(
        [fauxToolCall("write", { path: "整理清单.md", content: `# 整理清单\n\n工作目录里现在有：\n\n${listing.split("\n").filter(Boolean).map((l) => `- ${l}`).join("\n")}\n` })],
        { stopReason: "toolUse" },
      );
    }
    const rejected = since[1]?.isError || /拒绝/.test(textOf(since[1]));
    return fauxAssistantMessage(rejected ? "看了目录，但写清单的操作被你拒绝了，所以没有写文件。" : "看了目录，清单已写到 整理清单.md。");
  };

  // every call goes through the same factory; keep plenty queued
  faux.setResponses(Array.from({ length: 500 }, () => respond));
  return faux;
}
