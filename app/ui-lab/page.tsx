import Link from "next/link";

const projectTasks = [
  ["确认新版产品定位", "完成"],
  ["把首页接入真实 Agent 更新", "进行中"],
  ["录制 90 秒比赛演示", "待办"],
];

export default function UiLab() {
  return (
    <main className="ui-lab">
      <header className="lab-head">
        <div><span>OPS · UI LAB</span><h1>同一套工作结构，三种使用深度</h1><p>这是只读视觉模板。可以改排版、颜色、字和组件，不触碰飞书、D1 或写回合同。</p></div>
        <Link href="/">返回工作台</Link>
      </header>

      <section className="lab-rules">
        <b>设计检查</b>
        <span>5 秒内看见：我在哪</span>
        <span>什么最值得推进</span>
        <span>Agent 有更新时才出现</span>
        <span>会改变状态的动作必须说清楚</span>
      </section>

      <div className="lab-scenes">
        <article className="lab-scene">
          <header><span>01 · SOLO</span><b>没有 Agent，也完整成立</b></header>
          <div className="lab-orientation"><small>今天</small><h2>正在进行 <em>3</em> 件事</h2><p>4 个项目中，2 件现在可由你推进，1 件正在等待</p></div>
          <div className="lab-focus">
            <div><span>现在最值得推进</span><strong>查看新版并反馈</strong><small>OPS · 今天</small></div>
            <i>进行中</i>
          </div>
          <div className="lab-project">
            <div><span>当前项目</span><strong>OPS</strong><b>33%</b></div>
            {projectTasks.map(([task, status]) => <p key={task}><i className={status === "完成" ? "done" : status === "进行中" ? "running" : ""} />{task}<small>{status}</small></p>)}
          </div>
          <footer>项目、下一步、等待项和时间，独自使用时不需要任何 Agent 概念。</footer>
        </article>

        <article className="lab-scene assisted">
          <header><span>02 · ASSISTED</span><b>Agent 更新进入原任务</b></header>
          <div className="lab-agent">
            <b>CO</b><div><strong>Codex</strong><p>正在把首页接入真实 Agent 更新</p><small>OPS · 7 分钟前</small></div><i>1</i>
          </div>
          <div className="lab-event"><span>11:20</span><div><b>开始工作</b><p>已读取产品定位与现有数据合同。</p></div></div>
          <div className="lab-event"><span>11:52</span><div><b>进度更新</b><p>MiniDock 已改为从真实运行记录生成。</p></div></div>
          <div className="lab-question"><span>需要你回复</span><p>项目页继续保留四张项目卡，还是先收成两个重点项目？</p><button type="button">直接回复 Agent</button></div>
          <footer>“在线”不算进展；只有开工、进度、问题、交付和失败会进入工作台。</footer>
        </article>

        <article className="lab-scene collaborative">
          <header><span>03 · COLLABORATIVE</span><b>反馈闭环有证据</b></header>
          <div className="lab-thread">
            <div><b>Codex</b><p>项目页继续保留四张项目卡，还是先收成两个重点项目？</p><small>等你回复</small></div>
            <div className="max"><b>你</b><p>先保留四张，但首页最多只露出四件现在要管的事。</p><small>已发送</small></div>
          </div>
          <div className="lab-ack"><i>✓</i><div><b>Codex 已收到并确认</b><small>arct_demo_ack_001</small></div></div>
          <div className="lab-result"><span>结果回到项目</span><strong>首页信息层级已按四件上限调整</strong><small>Artifact · OPS vNext</small></div>
          <footer>你的回复、Agent 确认和最后交付属于同一任务，不另造一套协作系统。</footer>
        </article>
      </div>

      <section className="lab-handoff"><span>给下一位视觉 Agent</span><p>优先调整视觉密度、字级、色彩和组件气质；保留三条硬约束：Solo 不依赖 Agent、Agent 只在有工作变化时出现、所有状态写回继续走现有飞书合同。</p></section>
    </main>
  );
}
