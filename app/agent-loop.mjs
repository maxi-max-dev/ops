export function advanceRun(run) {
  if (run.stage === "review" || run.stage === "done") return run;
  const nextStep = (run.step ?? 0) + 1;
  const reachedReview = nextStep >= 2;
  return {
    ...run,
    step: nextStep,
    stage: reachedReview ? "review" : "running",
    status: reachedReview ? "结果待你拍板" : "继续执行",
    artifact: reachedReview
      ? run.artifact ?? {
          kind: "执行结果",
          title: "任务候选结果已准备好",
          summary: "Agent 已完成约定里程碑；采纳前不会写入正式数据，也不会触发外部动作。",
        }
      : run.artifact,
    events: [
      ...run.events,
      {
        time: "刚刚",
        label: reachedReview ? "交付候选结果" : "完成一个执行切片",
        detail: reachedReview
          ? "已生成结果卡，停止在人工拍板门前。"
          : "已记录过程证据，继续下一步。",
      },
    ],
  };
}
