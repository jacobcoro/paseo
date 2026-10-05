const chinese: Record<string, string> = {
  "Codex · Live": "Codex · 实时对话",
  "Could not change language": "无法修改语言",
  "图片 / Images: PNG, JPEG, WebP · 4 / prompt · 2 MiB / image":
    "图片：PNG、JPEG、WebP，每次最多 4 张，每张上限 2 MiB",
  "New chat": "新建对话",
  "Chat / 对话": "对话",
  "Choose chat": "选择对话",
  "No chats": "暂无对话",
  "Read only": "只读",
  "Saving settings…": "正在保存设置…",
  "Loading models": "正在加载模型",
  Reasoning: "推理强度",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
  ultra: "极高",
  Discover: "探索",
  Define: "定义",
  Develop: "发展",
  Deliver: "交付",
  "Could not create chat": "无法新建对话",
  "Could not change model settings": "无法修改模型设置",
  "Sign out failed": "退出失败",
  "Wait for the reply to finish before changing settings": "请等待回复完成后再修改设置",
  "Wait for the current reply before changing chats": "请等待当前回复完成后再切换对话",
  "This model or reasoning level is unavailable. Astra is blocked.":
    "该模型或推理强度不可用。Astra 已禁用。",
  "Choose a model and reasoning level": "请选择模型和推理强度",
  "Wait one minute before creating another chat": "请等待一分钟后再新建对话",
  "You have reached the 20 chat limit": "已达到 20 个对话上限",
  "A new chat is already being created": "正在新建对话，请稍候",
  "Conversation not found": "找不到该对话",
  "Model list is unavailable. Retry shortly.": "暂时无法加载模型列表，请稍后重试。",
  "Wait a minute before changing settings again": "请等待一分钟后再修改设置",
};

export function studyLabel(
  text: string,
  language = localStorage.getItem("study.language"),
): string {
  const english = language === "en";
  const parts = text.split(" / ");
  if (parts.length === 2 && /[\u3400-\u9fff]/.test(parts[0])) return parts[english ? 1 : 0];
  if (text === "Chat / 对话") return english ? "Chat" : "对话";
  return english ? text : chinese[text] || text;
}
