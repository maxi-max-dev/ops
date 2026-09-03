const completionWords = /完成|做完|做好|搞定|弄完|交完|递交|提交|投递|报完名|报名.*(?:完|好)/;

const anchors = [
  ["报名", "报名"],
  ["报完名", "报名"],
  ["简历", "简历"],
  ["投递", "投递"],
  ["递交", "简历"],
  ["微信", "微信"],
  ["聊天记录", "聊天记录"],
];

/**
 * @param {string} raw
 * @param {{id:string,title:string,done:boolean,projectId:string,projectName:string}[]} tasks
 */
export function interpretVoice(raw, tasks) {
  const text = raw.trim().replace(/[，。！？,.!?]/g, "");
  if (!text || !completionWords.test(text)) return { kind: "capture", text };

  let best = null;
  for (const task of tasks.filter((item) => !item.done)) {
    let score = text.includes(task.title) ? 10 : 0;
    for (const [spoken, target] of anchors) {
      if (text.includes(spoken) && task.title.includes(target)) score += 3;
    }
    if (!best || score > best.score) best = { task, score };
  }

  if (!best || best.score < 3) return { kind: "capture", text };
  return {
    kind: "complete",
    text,
    taskId: best.task.id,
    taskTitle: best.task.title,
    projectId: best.task.projectId,
    projectName: best.task.projectName,
    confidence: best.score >= 6 ? "high" : "medium",
  };
}
