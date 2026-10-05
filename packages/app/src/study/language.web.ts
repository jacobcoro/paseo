const chinese: Record<string, string> = {
  "Codex · Live": "Codex · 实时对话",
  "Could not change language": "无法修改语言",
  "File is over 8 MiB": "文件超过 8 MiB 上限",
  "Open the message box, then try dictation again.": "请先打开输入框，再尝试语音输入。",
  "No speech was detected.": "没有识别到语音。",
  "Reading the latest reply. Browser speech may need a network connection and may not work in China.":
    "正在朗读最新回复。浏览器语音可能需要联网，在中国可能无法使用。",
  "图片 / Images: PNG, JPEG, WebP · 4 / prompt · 2 MiB / image":
    "图片：PNG、JPEG、WebP，每次最多 4 张，每张上限 2 MiB",
  "New chat": "新建对话",
  "Chat / 对话": "对话",
  "Choose chat": "选择对话",
  "No chats": "暂无对话",
  "Read only": "只读",
  "Upload documents": "上传文件",
  Download: "下载",
  Dictate: "语音输入",
  "Read latest reply": "朗读最新回复",
  Memory: "记忆",
  "Hide memory": "收起记忆",
  "Save memory": "保存记忆",
  Clear: "清空",
  "Study memory": "对话记忆",
  "Your notes for future chats. Keep private details out. Max 8 KiB.":
    "保存供以后对话使用的笔记。请勿填写隐私信息。上限 8 KiB。",
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
  "Upload complete. Ask about the file by name.": "上传完成。可以告诉 AI 文件名并提问。",
  "Upload failed": "上传失败",
  "Could not create chat": "无法新建对话",
  "Could not change model settings": "无法修改模型设置",
  "Could not save memory": "无法保存记忆",
  "Could not clear memory": "无法清空记忆",
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
  "Dictation is unavailable in this browser.": "当前浏览器不支持语音输入。",
  "Dictation added. Review the text before sending.": "已输入语音文字，请检查后发送。",
  "Dictation failed. Check browser microphone access and network.":
    "语音输入失败，请检查麦克风权限和网络。",
  "Listening…": "正在聆听…",
  "Dictation could not start. Check browser microphone access.":
    "无法开始语音输入，请检查麦克风权限。",
  "Could not load the latest reply.": "无法读取最新回复。",
  "This chat has no reply yet.": "此对话尚无回复。",
  "Read aloud is unavailable in this browser.": "当前浏览器不支持朗读。",
  "Could not connect to the study service.": "无法连接研究网站。",
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
