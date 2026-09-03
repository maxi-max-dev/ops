"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  FEISHU_EMBEDDED_ENDPOINTS,
  presentFeishuBoundary,
} from "./feishu-embedded";
import {
  FEISHU_AI_STORAGE_KEY,
  loadStoredFeishuBase,
  normalizeFeishuBaseUrl,
  parseFeishuAiHandoff,
} from "./feishu-ai-handoff.mjs";
import {
  buildAgentPairingInstruction,
  MAXOPS_CONNECTOR_URL,
  ONE_CLICK_INSTALL_ENDPOINTS,
  PUBLIC_FEISHU_INSTALLATION,
} from "./feishu-onboarding.mjs";

type Owner = "我" | "Agent" | "一起";
type TaskStage = "todo" | "running" | "waiting" | "done" | "abandoned" | "open";
type DataMode = "connecting" | "local" | "feishu" | "feishu_syncing" | "error";
type Tab = "today" | "projects" | "updates" | "completed";

type Task = {
  recordId?: string;
  id: string;
  title: string;
  done: boolean;
  stage?: TaskStage;
  version?: number;
  owner: Owner;
  priority: "high" | "normal";
  relation: string;
  writable?: boolean;
};

type Project = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  goal: string;
  due: string;
  accent: string;
  tasks: Task[];
};

type AgentRun = {
  id: string;
  agentId: string;
  agentName?: string;
  agentMark?: string;
  agentAccent?: string;
  projectId: string;
  taskId: string;
  stage: "running" | "review" | "failed" | "done";
  status: string;
  eta: string;
  events: { time: string; label: string; detail: string }[];
  artifact?: { title: string; summary: string; kind: string; url?: string | null };
};

type AgentMessage = {
  message_id: string;
  task_id: string;
  record_id?: string | null;
  run_id?: string | null;
  agent_id: string;
  direction: "to_max" | "to_agent";
  kind: "question" | "instruction" | "answer";
  body: string;
  in_reply_to?: string | null;
  status: "pending" | "answered" | "delivered" | "acknowledged" | "preparing";
  created_by: string;
  created_at: number;
  delivered_at?: number | null;
  acknowledged_at?: number | null;
};

type AgentReceipt = {
  receipt_id: string;
  subject_type: string;
  subject_id: string;
  agent_id: string;
  kind: string;
  created_at: number;
};

type Receipt = {
  receipt_id: string;
  run_id: string;
  status: string;
  task_id: string;
  notification_status: string;
};

type SourceEvent = {
  id: string;
  occurredAt: number;
  actor: string;
  title: string;
  status: string;
  detail: string;
  taskId?: string | null;
};

type ProjectSignal = {
  id: string;
  recordId?: string;
  receiptId?: string;
  taskId: string;
  runId?: string;
  agentId?: string;
  agentName?: string;
  kind: string;
  category: "event" | "question" | "feedback" | "artifact" | "receipt" | "report" | "incident";
  title: string;
  detail: string;
  status: string;
  occurredAt: number;
  artifactUrl?: string | null;
};

type FreshBaseMeta = {
  source: "fresh-copy";
  url: string;
  retrievedAt: number;
  tables: { key: string; id: string; name: string }[];
};

type InstallStatus = {
  state: "ready" | "permission_gate";
  installUrl: string | null;
  label: string;
  reason?: string | null;
  installed?: boolean;
};

type InstallWorkspace = {
  installed: true;
  displayName: string;
  links: { feishu: string; dashboard: string };
  agents: Array<{ id: string; name: string; connected: boolean; receipt?: string | null; revoked: boolean }>;
};

type StatusUpdate = {
  id: string;
  time: string;
  project: string;
  task: string;
  from: string;
  to: string;
  initiatedBy: string;
  executedBy: string;
  reason: string;
  receipt: string;
};

const demoProjects: Project[] = [
  {
    id: "launch",
    code: "DEMO / 01",
    name: "山岚随行杯 · 秋季发布",
    shortName: "秋季发布",
    goal: "把用户反馈、发布主张与素材交付收在同一个项目房间",
    due: "周五",
    accent: "#315bd6",
    tasks: [
      { id: "launch-date", recordId: "demo_rec_01", title: "锁定发布日期", done: true, stage: "done", owner: "我", priority: "high", relation: "时间表" },
      { id: "launch-insights", recordId: "demo_rec_02", title: "汇总 20 条用户访谈", done: false, stage: "running", owner: "Agent", priority: "high", relation: "Codex 正在整理" },
      { id: "launch-claim", recordId: "demo_rec_03", title: "确认发布页第一主卖点", done: false, stage: "waiting", owner: "一起", priority: "high", relation: "等你确认" },
      { id: "launch-assets", recordId: "demo_rec_04", title: "整理发布素材清单", done: false, stage: "todo", owner: "我", priority: "normal", relation: "交付准备" },
    ],
  },
  {
    id: "support",
    code: "DEMO / 02",
    name: "客服知识库升级",
    shortName: "知识库",
    goal: "把重复问题变成客服可以直接采用的答案",
    due: "下周三",
    accent: "#c66543",
    tasks: [
      { id: "support-sample", title: "抽样最近 50 条咨询", done: true, stage: "done", owner: "Agent", priority: "normal", relation: "ResearchBot 已完成" },
      { id: "support-cluster", title: "归纳高频问题", done: false, stage: "running", owner: "Agent", priority: "high", relation: "ResearchBot 正在做" },
      { id: "support-review", title: "审核新版回答语气", done: false, stage: "todo", owner: "我", priority: "normal", relation: "内容检查" },
    ],
  },
  {
    id: "weekend",
    code: "DEMO / 03",
    name: "周末城市漫游",
    shortName: "城市漫游",
    goal: "把零散想法收成一条轻松、走得完的路线",
    due: "周六",
    accent: "#6b58b7",
    tasks: [
      { id: "weekend-list", title: "收集 6 个候选地点", done: true, stage: "done", owner: "Agent", priority: "normal", relation: "OpenClaw 已整理" },
      { id: "weekend-route", title: "生成步行路线", done: false, stage: "running", owner: "Agent", priority: "normal", relation: "OpenClaw 正在做" },
      { id: "weekend-book", title: "确认晚餐是否需要预约", done: false, stage: "waiting", owner: "我", priority: "normal", relation: "等餐厅回复" },
    ],
  },
];

const demoRuns: AgentRun[] = [
  {
    id: "run-codex",
    agentId: "codex",
    agentName: "Codex",
    agentMark: "CO",
    agentAccent: "#3f63f2",
    projectId: "launch",
    taskId: "launch-insights",
    stage: "review",
    status: "已整理访谈，等你确认主卖点",
    eta: "2 分钟前更新",
    events: [
      { time: "14:02", label: "开始工作", detail: "读取指定任务与 20 条脱敏访谈记录。" },
      { time: "14:06", label: "更新进度", detail: "已归纳出轻便、续航、清洗三个主题。" },
      { time: "14:09", label: "提出问题", detail: "两个主卖点接近，需要你确认第一优先级。" },
    ],
    artifact: { title: "访谈主题摘要.md", summary: "20 条反馈已归为 3 个主题，并保留来源编号。", kind: "DEMO ARTIFACT" },
  },
  {
    id: "run-research-bot",
    agentId: "research-bot",
    agentName: "ResearchBot",
    agentMark: "RB",
    agentAccent: "#ce6b4c",
    projectId: "support",
    taskId: "support-cluster",
    stage: "running",
    status: "正在归纳高频问题",
    eta: "刚刚更新",
    events: [{ time: "刚刚", label: "进度更新", detail: "已完成 31/50 条咨询的主题归类。" }],
  },
  {
    id: "run-openclaw",
    agentId: "openclaw",
    agentName: "OpenClaw",
    agentMark: "OC",
    agentAccent: "#18846f",
    projectId: "weekend",
    taskId: "weekend-list",
    stage: "done",
    status: "候选地点已整理",
    eta: "46 分钟前更新",
    events: [{ time: "13:22", label: "已完成", detail: "整理 6 个地点，并标注开放时间与步行距离。" }],
  },
];

const demoMessages: AgentMessage[] = [
  {
    message_id: "amsg_demo_question_pending",
    task_id: "launch-insights",
    run_id: "run-codex",
    agent_id: "codex",
    direction: "to_max",
    kind: "question",
    body: "20 条访谈里，“轻便”出现 12 次，“续航”出现 8 次。发布页先把哪一个放在第一屏？",
    status: "pending",
    created_by: "Codex",
    created_at: Date.now() - 2 * 60_000,
  },
];

const demoAgentReceipts: AgentReceipt[] = [];

const stageCopy: Record<TaskStage, string> = {
  todo: "待办",
  open: "待办",
  running: "进行中",
  waiting: "等外部",
  done: "完成",
  abandoned: "放弃",
};

const messageStatusCopy: Record<AgentMessage["status"], string> = {
  pending: "等待处理",
  answered: "你已回复",
  delivered: "Agent 已收到",
  acknowledged: "Agent 已确认",
  preparing: "正在送达",
};

function stageOf(task: Task): TaskStage {
  if (task.stage && task.stage !== "open") return task.stage;
  return task.done ? "done" : "todo";
}

function projectProgress(project: Project) {
  const active = project.tasks.filter((task) => stageOf(task) !== "abandoned");
  return Math.round((active.filter((task) => stageOf(task) === "done").length / Math.max(active.length, 1)) * 100);
}

function timeNow() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

export default function Home() {
  const [projects, setProjects] = useState<Project[]>(demoProjects);
  const [runs, setRuns] = useState<AgentRun[]>(demoRuns);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>(demoMessages);
  const [agentReceipts, setAgentReceipts] = useState<AgentReceipt[]>(demoAgentReceipts);
  const [sourceEvents, setSourceEvents] = useState<SourceEvent[]>([]);
  const [projectSignals, setProjectSignals] = useState<ProjectSignal[]>([]);
  const [freshBase, setFreshBase] = useState<FreshBaseMeta | null>(null);
  const [personalFeishuBaseUrl, setPersonalFeishuBaseUrl] = useState<string | null>(null);
  const [feishuSetupOpen, setFeishuSetupOpen] = useState(false);
  const [feishuSetupDraft, setFeishuSetupDraft] = useState("");
  const [feishuSetupError, setFeishuSetupError] = useState("");
  const [feishuAgentName, setFeishuAgentName] = useState("Codex");
  const [agentInstructionCopied, setAgentInstructionCopied] = useState(false);
  const [installStatus, setInstallStatus] = useState<InstallStatus>({
    state: PUBLIC_FEISHU_INSTALLATION.status,
    installUrl: PUBLIC_FEISHU_INSTALLATION.url,
    label: PUBLIC_FEISHU_INSTALLATION.label,
  });
  const [installWorkspace, setInstallWorkspace] = useState<InstallWorkspace | null>(null);
  const [pairingInstruction, setPairingInstruction] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [oneClickInstalled, setOneClickInstalled] = useState(false);
  const [showcaseDemo, setShowcaseDemo] = useState(false);
  const [dataMode, setDataMode] = useState<DataMode>("connecting");
  const [syncDetail, setSyncDetail] = useState("正在连接飞书");
  const [tab, setTab] = useState<Tab>("today");
  const [selectedProjectId, setSelectedProjectId] = useState("launch");
  const [selectedTaskId, setSelectedTaskId] = useState("launch-insights");
  const [composer, setComposer] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [updates, setUpdates] = useState<StatusUpdate[]>([
    {
      id: "demo-update-1",
      time: "12:08",
      project: "知识库",
      task: "归纳高频问题",
      from: "待办",
      to: "进行中",
      initiatedBy: "ResearchBot",
      executedBy: "OPS Preview",
      reason: "已完成首批咨询分类",
      receipt: "demo_rcpt_1404",
    },
  ]);
  const askAiHandoffUrl = freshBase?.url ?? personalFeishuBaseUrl;
  const agentPairingInstruction = pairingInstruction ?? buildAgentPairingInstruction({ agentName: feishuAgentName });

  async function loadInstallation() {
    try {
      const statusResponse = await fetch(ONE_CLICK_INSTALL_ENDPOINTS.status, { credentials: "include", cache: "no-store" });
      if (statusResponse.ok) {
        const status = await statusResponse.json() as InstallStatus;
        setInstallStatus(status);
        if (status.installed) {
          const workspaceResponse = await fetch(ONE_CLICK_INSTALL_ENDPOINTS.workspace, { credentials: "include", cache: "no-store" });
          if (workspaceResponse.ok) {
            const workspace = await workspaceResponse.json() as InstallWorkspace;
            setInstallWorkspace(workspace);
            setOneClickInstalled(true);
          }
        }
      }
    } catch {
      // Static Pages has no confidential backend. The checked-in fail-closed
      // status remains authoritative until a real installer is published.
    }
  }

  async function syncFromFeishu(silent = false) {
    if (!silent) setDataMode("connecting");
    try {
      let response = await fetch(ONE_CLICK_INSTALL_ENDPOINTS.dashboard, { credentials: "include", cache: "no-store" });
      let installedSource = response.ok;
      if (response.status === 401 || response.status === 404) {
        response = await fetch(FEISHU_EMBEDDED_ENDPOINTS.state, { credentials: "include", cache: "no-store" });
        installedSource = false;
      }
      if (response.status === 401 || response.status === 404) {
        setDataMode("local");
        setSyncDetail("PREVIEW · 本地端内投影");
        return false;
      }
      if (response.status === 403) {
        setDataMode("error");
        setSyncDetail("飞书已连接 · 当前账号待授权");
        return false;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as {
        mode?: string;
        actor?: string;
        projects?: Project[];
        runs?: AgentRun[];
        sourceEvents?: SourceEvent[];
        agentMessages?: AgentMessage[];
        agentReceipts?: AgentReceipt[];
        signals?: ProjectSignal[];
        base?: FreshBaseMeta;
      };
      if (payload.mode !== "feishu" || !payload.projects?.length) throw new Error("Invalid Feishu state");
      setProjects(payload.projects);
      setRuns(payload.runs ?? []);
      setSourceEvents(payload.sourceEvents ?? []);
      setAgentMessages(payload.agentMessages ?? []);
      setAgentReceipts(payload.agentReceipts ?? []);
      setProjectSignals(payload.signals ?? []);
      setFreshBase(payload.base ?? null);
      setOneClickInstalled(installedSource);
      setDataMode("feishu");
      setSyncDetail(`${payload.actor ?? "当前用户"} · fresh copy 五张业务表已同步`);
      const stillSelected = payload.projects.some((project) => project.id === selectedProjectId);
      if (!stillSelected) {
        setSelectedProjectId(payload.projects[0].id);
        setSelectedTaskId(payload.projects[0].tasks.find((task) => !task.done)?.id ?? payload.projects[0].tasks[0]?.id ?? "");
      }
      return true;
    } catch {
      setDataMode("local");
      setSyncDetail("PREVIEW · 服务端投影未连接");
      return false;
    }
  }

  useEffect(() => {
    const handoffTimer = window.setTimeout(() => {
      const target = parseFeishuAiHandoff(window.location) ?? loadStoredFeishuBase(window.localStorage);
      setPersonalFeishuBaseUrl(target);
      setFeishuSetupDraft(target ?? "");
    }, 0);
    return () => window.clearTimeout(handoffTimer);
  }, []);

  useEffect(() => {
    if (!feishuSetupOpen || !oneClickInstalled) return;
    const interval = window.setInterval(() => void loadInstallation(), 5_000);
    return () => window.clearInterval(interval);
    // The polling contract is intentionally keyed only to the modal/install
    // state; loadInstallation itself does not retain render-time data.
  }, [feishuSetupOpen, oneClickInstalled]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      void loadInstallation();
      if (params.get("installed") === "1") {
        setFeishuSetupOpen(true);
        const clean = new URL(window.location.href);
        clean.searchParams.delete("installed");
        window.history.replaceState(null, "", `${clean.pathname}${clean.search}${clean.hash}`);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") {
      const demoTimer = window.setTimeout(() => {
        setShowcaseDemo(true);
        setDataMode("local");
        setSyncDetail("DEMO DATA · 全部内容均为虚构示例");
        if (params.get("view") === "projects") setTab("projects");
      }, 0);
      return () => window.clearTimeout(demoTimer);
    }
    // Initial client synchronization with the external Feishu projection.
    const initialSyncTimer = window.setTimeout(() => void syncFromFeishu(), 0);
    const interval = window.setInterval(() => void syncFromFeishu(true), 20_000);
    return () => {
      window.clearTimeout(initialSyncTimer);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (freshBase?.url) window.location.assign(freshBase.url);
        else if (personalFeishuBaseUrl) window.open(personalFeishuBaseUrl, "_blank", "noopener,noreferrer");
        else setComposerOpen(true);
      }
      if (event.key === "Escape") {
        setComposerOpen(false);
        setFeishuSetupOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [freshBase, personalFeishuBaseUrl]);

  const allTasks = useMemo(() => projects.flatMap((project) => project.tasks.map((task) => ({ ...task, project }))), [projects]);
  const activeTasks = allTasks.filter((task) => stageOf(task) !== "done" && stageOf(task) !== "abandoned");
  const inProgress = allTasks.filter((task) => stageOf(task) === "running").length;
  const activeProjects = projects.filter((project) => project.tasks.some((task) => !["done", "abandoned"].includes(stageOf(task)))).length;
  const attentionTasks = activeTasks
    .slice()
    .sort((a, b) => Number(b.priority === "high" && b.owner !== "Agent") - Number(a.priority === "high" && a.owner !== "Agent"))
    .slice(0, 4);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const selectedTask = allTasks.find((task) => task.id === selectedTaskId) ?? attentionTasks[0] ?? allTasks[0];
  const selectedMessages = agentMessages
    .filter((message) => message.task_id === selectedTask?.id)
    .slice()
    .sort((a, b) => a.created_at - b.created_at);
  const selectedRun = runs.find((run) => run.taskId === selectedTask?.id);
  const selectedSignals = projectSignals.filter((signal) => signal.taskId === selectedTask?.id);
  const selectedAgentUpdates = selectedSignals.filter((signal) => ["event", "report", "incident"].includes(signal.category));
  const selectedIssues = selectedSignals.filter((signal) => ["question", "feedback"].includes(signal.category));
  const selectedArtifacts = selectedSignals.filter((signal) => ["artifact", "receipt"].includes(signal.category));
  const pendingQuestion = selectedMessages.findLast((message) => message.direction === "to_max" && message.kind === "question" && message.status === "pending");
  const selectedMessageReceipt = [...agentReceipts]
    .reverse()
    .find((receipt) => selectedMessages.some((message) => message.message_id === receipt.subject_id));
  const completedTasks = allTasks.filter((task) => stageOf(task) === "done");
  const completed = completedTasks.length;
  const waiting = allTasks.filter((task) => stageOf(task) === "waiting").length;
  const maxNow = allTasks.filter((task) => task.owner !== "Agent" && task.priority === "high" && !["done", "abandoned"].includes(stageOf(task))).length;

  function selectProject(project: Project) {
    setSelectedProjectId(project.id);
    const next = project.tasks.find((task) => !["done", "abandoned"].includes(stageOf(task))) ?? project.tasks[0];
    if (next) setSelectedTaskId(next.id);
  }

  function selectTask(task: Task, projectId?: string) {
    setSelectedTaskId(task.id);
    if (projectId) setSelectedProjectId(projectId);
  }

  function handleSyncButton() {
    if (showcaseDemo) return;
    void syncFromFeishu();
  }

  function openAskAi() {
    if (freshBase?.url) {
      window.location.assign(freshBase.url);
      return;
    }
    if (personalFeishuBaseUrl) {
      window.open(personalFeishuBaseUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setComposerOpen(true);
  }

  function openFeishuSetup() {
    setFeishuSetupDraft(personalFeishuBaseUrl ?? "");
    setFeishuSetupError("");
    setAgentInstructionCopied(false);
    setPairingInstruction(null);
    setFeishuSetupOpen(true);
    void loadInstallation();
  }

  function beginFeishuInstallation() {
    if (installStatus.installUrl) {
      window.location.assign(installStatus.installUrl);
      return;
    }
    setFeishuSetupError(installStatus.reason ?? "还不能给普通用户安装：飞书的非公开商店应用与 OAuth 回调尚未发布。当前页面不会把技术配置冒充一键接入。");
  }

  async function copyAgentPairingInstruction() {
    if (!installWorkspace) {
      setFeishuSetupError("请先完成飞书授权。安装成功后，这里才会生成真实的一次性配对链接。");
      return;
    }
    setPairingBusy(true);
    try {
      let instruction = pairingInstruction;
      if (!instruction) {
        const response = await fetch(ONE_CLICK_INSTALL_ENDPOINTS.pair, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentName: feishuAgentName }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json() as { instruction: string };
        instruction = result.instruction;
        setPairingInstruction(instruction);
      }
      await window.navigator.clipboard.writeText(instruction);
      setAgentInstructionCopied(true);
      setFeishuSetupError("");
    } catch {
      setFeishuSetupError("没有生成或复制成功。请确认安装仍有效后再试。");
    } finally {
      setPairingBusy(false);
    }
  }

  async function revokeInstalledAgent(agentId: string) {
    try {
      const response = await fetch(`/api/install/agents/${encodeURIComponent(agentId)}/revoke`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadInstallation();
    } catch {
      setFeishuSetupError("没有撤销成功；旧凭据状态未改变，请重试。");
    }
  }

  async function revokeInstallation() {
    if (!window.confirm("撤销 OPS 接入？Agent 凭据会立即失效，但你的飞书 Base 会完整保留。")) return;
    try {
      const response = await fetch(ONE_CLICK_INSTALL_ENDPOINTS.revoke, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setInstallWorkspace(null);
      setOneClickInstalled(false);
      setFreshBase(null);
      setDataMode("local");
      setSyncDetail("PREVIEW · OPS 接入已撤销，飞书 Base 保留");
      setFeishuSetupError("OPS 接入与 Agent 凭据已撤销；你的飞书 Base 没有删除。");
    } catch {
      setFeishuSetupError("没有撤销成功；当前接入状态未改变，请重试。");
    }
  }

  function saveFeishuSetup() {
    const target = normalizeFeishuBaseUrl(feishuSetupDraft);
    if (!target) {
      setFeishuSetupError("请粘贴一个完整的飞书多维表格链接，例如 https://example.feishu.cn/base/BASE_TOKEN");
      return;
    }
    try {
      window.localStorage.setItem(FEISHU_AI_STORAGE_KEY, target);
    } catch {
      setFeishuSetupError("当前浏览器不允许保存。请关闭严格隐私限制后再试。");
      return;
    }
    setPersonalFeishuBaseUrl(target);
    setFeishuSetupDraft(target);
    setFeishuSetupError("");
    setFeishuSetupOpen(false);
    window.open(target, "_blank", "noopener,noreferrer");
  }

  function forgetFeishuSetup() {
    try {
      window.localStorage.removeItem(FEISHU_AI_STORAGE_KEY);
    } catch {
      // The in-memory connection can still be removed when storage is unavailable.
    }
    const cleanUrl = new URL(window.location.href);
    cleanUrl.hash = "";
    window.history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}`);
    setPersonalFeishuBaseUrl(null);
    setFeishuSetupDraft("");
    setFeishuSetupError("");
  }

  function updateLocalTask(taskId: string, nextStage: TaskStage) {
    setProjects((current) => current.map((project) => ({
      ...project,
      tasks: project.tasks.map((task) => task.id === taskId ? { ...task, stage: nextStage, done: nextStage === "done" } : task),
    })));
  }

  async function writeStage(task: typeof selectedTask, nextStage: TaskStage, reason: string) {
    if (!task) return null;
    if (freshBase && task.writable === false) throw new Error("Fresh-copy task state is maintained by Base and Connector");
    const before = stageCopy[stageOf(task)];
    if (dataMode === "feishu" && task.recordId) {
      const response = await fetch(oneClickInstalled ? ONE_CLICK_INSTALL_ENDPOINTS.taskUpdate : FEISHU_EMBEDDED_ENDPOINTS.taskCommand, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "Idempotency-Key": `vnext:${crypto.randomUUID()}` },
        body: JSON.stringify({
          taskId: task.id,
          recordId: task.recordId,
          targetState: nextStage,
          expectedVersion: task.version ?? 0,
          idempotencyKey: `vnext:${crypto.randomUUID()}`,
          label: reason,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as { receipt?: Receipt | string };
      await syncFromFeishu(true);
      return { before, receipt: typeof result.receipt === "string" ? result.receipt : result.receipt?.receipt_id ?? `rcpt_${Date.now()}` };
    }
    updateLocalTask(task.id, nextStage);
    return { before, receipt: `demo_${Date.now().toString(36)}` };
  }

  function inferStage(text: string): TaskStage {
    if (/放弃|取消|不做/.test(text)) return "abandoned";
    if (/等|等待|卡住|外部/.test(text)) return "waiting";
    if (/完成|做完|做好|搞定|验收|可以了|提交了|交付了/.test(text)) return "done";
    return "running";
  }

  async function applyStatusUpdate() {
    const text = composer.trim();
    if (!text || !selectedTask || updating) return;
    const target = inferStage(text);
    setUpdating(true);
    try {
      const result = await writeStage(selectedTask, target, `用户：${text}`);
      if (!result) return;
      const project = projects.find((item) => item.id === selectedTask.project.id) ?? selectedTask.project;
      setUpdates((current) => [{
        id: `update-${Date.now()}`,
        time: timeNow(),
        project: project.shortName,
        task: selectedTask.title,
        from: result.before,
        to: stageCopy[target],
        initiatedBy: "当前用户",
        executedBy: dataMode === "feishu" ? "OPS AI · 飞书写回" : "OPS AI · 预览",
        reason: text,
        receipt: result.receipt,
      }, ...current]);
      setComposer("");
      setComposerOpen(false);
      setTab("today");
    } catch {
      setUpdates((current) => [{
        id: `failed-${Date.now()}`,
        time: timeNow(), project: selectedTask.project.shortName, task: selectedTask.title,
        from: stageCopy[stageOf(selectedTask)], to: "未改变", initiatedBy: "当前用户",
        executedBy: "OPS AI", reason: `${text}（写回失败，飞书原值未变）`, receipt: "failed",
      }, ...current]);
    } finally {
      setUpdating(false);
    }
  }

  async function replyToAgent() {
    const body = replyDraft.trim();
    if (!body || !selectedTask || !pendingQuestion || replying) return;
    setReplying(true);
    setReplyError("");
    try {
      if (dataMode === "feishu" && selectedTask.recordId) {
        const response = await fetch(FEISHU_EMBEDDED_ENDPOINTS.agentInstruction, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "Idempotency-Key": `ui-reply:${crypto.randomUUID()}` },
          body: JSON.stringify({
            task_id: selectedTask.id,
            record_id: selectedTask.recordId,
            run_id: pendingQuestion.run_id,
            agent_id: pendingQuestion.agent_id,
            body,
            in_reply_to: pendingQuestion.message_id,
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await syncFromFeishu(true);
      } else {
        const answerId = `amsg_demo_answer_${crypto.randomUUID()}`;
        setAgentMessages((current) => [
          ...current.map((message) => message.message_id === pendingQuestion.message_id ? { ...message, status: "answered" as const } : message),
          {
            message_id: answerId,
            task_id: selectedTask.id,
            run_id: pendingQuestion.run_id,
            agent_id: pendingQuestion.agent_id,
            direction: "to_agent",
            kind: "answer",
            body,
            in_reply_to: pendingQuestion.message_id,
            status: "pending",
            created_by: "当前用户",
            created_at: Date.now(),
          },
        ]);
        window.setTimeout(() => {
          setAgentMessages((current) => current.map((message) => message.message_id === answerId ? {
            ...message,
            status: "acknowledged",
            delivered_at: Date.now(),
            acknowledged_at: Date.now(),
          } : message));
          setAgentReceipts((current) => [...current, {
            receipt_id: `arct_demo_${Date.now().toString(36)}`,
            subject_type: "message",
            subject_id: answerId,
            agent_id: pendingQuestion.agent_id,
            kind: "acknowledged",
            created_at: Date.now(),
          }]);
        }, 700);
      }
      setReplyDraft("");
    } catch {
      setReplyError("没有发送成功，原任务和 Agent 收件箱都没有改变。请重试。");
    } finally {
      setReplying(false);
    }
  }

  async function setSelectedTaskStage(stage: TaskStage) {
    if (!selectedTask || updating) return;
    setUpdating(true);
    try {
      const result = await writeStage(selectedTask, stage, `用户手动改为${stageCopy[stage]}`);
      if (result) {
        setUpdates((current) => [{
          id: `manual-${Date.now()}`,
          time: timeNow(),
          project: selectedTask.project.shortName,
          task: selectedTask.title,
          from: result.before,
          to: stageCopy[stage],
          initiatedBy: "当前用户",
          executedBy: dataMode === "feishu" ? "OPS · 飞书写回" : "OPS · 预览",
          reason: `手动改为${stageCopy[stage]}`,
          receipt: result.receipt,
        }, ...current]);
      }
    } finally {
      setUpdating(false);
    }
  }

  const agentCards = useMemo(() => {
    const byAgent = new Map<string, AgentRun[]>();
    for (const run of runs) byAgent.set(run.agentId, [...(byAgent.get(run.agentId) ?? []), run]);
    return [...byAgent.entries()].map(([agentId, agentRuns]) => {
      const run = agentRuns.find((item) => item.stage !== "done") ?? agentRuns[0];
      const task = run ? allTasks.find((item) => item.id === run.taskId) : undefined;
      const name = run?.agentName || agentId;
      const unread = agentMessages.filter((message) => message.agent_id === agentId && message.direction === "to_max" && message.status === "pending").length;
      return {
        id: agentId,
        name,
        mark: run?.agentMark || name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
        color: run?.agentAccent || "#3f63f2",
        run,
        task,
        unread,
      };
    });
  }, [allTasks, agentMessages, runs]);

  const boundary = presentFeishuBoundary(dataMode, showcaseDemo);

  return (
    <div
      className={`ops-shell boundary-${boundary.mode}`}
      data-host="feishu-embedded"
      data-boundary={boundary.label}
    >
      <aside className="feishu-rail" aria-label="飞书端内模式">
        <div className="rail-mark">MO</div>
        <div className="rail-context"><b>OPS</b><span>H5 深度总览</span></div>
        <div className={`rail-boundary rail-boundary-${boundary.mode}`}><i /><span>{boundary.label}</span></div>
        <small>OPS 私有应用<br />Base 是唯一真源</small>
      </aside>

      <div className="embed-canvas">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setTab("today")}>
          <span>MO</span>
          <div><strong>OPS</strong><small>{showcaseDemo ? "虚构预览" : "个人工作总览"}</small></div>
        </button>
        <nav aria-label="主导航">
          <button className={tab === "today" ? "active" : ""} type="button" onClick={() => setTab("today")}>今天</button>
          <button className={tab === "projects" ? "active" : ""} type="button" onClick={() => setTab("projects")}>项目</button>
          <button className={tab === "updates" ? "active" : ""} type="button" onClick={() => setTab("updates")}>动态 <i>{freshBase ? projectSignals.length : updates.length}</i></button>
        </nav>
        <button className={`base-ai-shortcut ${freshBase ? "connected" : ""}`} type="button" onClick={freshBase ? openAskAi : openFeishuSetup}>
          <b>{freshBase ? "✓" : "↗"}</b><span>{freshBase ? "飞书数据已连接" : "接入数据与 Agent"}</span><small>{freshBase ? "打开同一 Base" : personalFeishuBaseUrl ? "快捷入口已保存" : "查看真实接入方式"}</small>
        </button>
        <button className={`sync-pill ${showcaseDemo ? "mode-demo" : `mode-${dataMode}`}`} type="button" disabled={showcaseDemo} aria-label={showcaseDemo ? "示例数据预览" : "刷新飞书任务投影"} onClick={handleSyncButton}>
          <i /><span>{showcaseDemo ? "PREVIEW · 示例数据" : dataMode === "feishu" ? "FEISHU LIVE · 刷新" : dataMode === "connecting" || dataMode === "feishu_syncing" ? "CHECKING · 正在确认" : "PREVIEW · 重试同步"}</span>
        </button>
      </header>

      <div className={`boundary-ribbon boundary-ribbon-${boundary.mode}`} role="status">
        <b>{boundary.label}</b><span>{boundary.detail}</span><small>{freshBase ? `fresh copy · ${freshBase.tables.length} 张表` : "OPS / H5 深度总览"}</small>
      </div>

      <div className={`workspace ${tab === "projects" ? "project-mode" : ""}`}>
        <main className="main-column">
          {tab === "today" && (
            <>
              <section className="orientation-card">
                <div className="orientation-copy">
                  <span className="eyebrow">今天 · 深度总览</span>
                  <h1>先看这 <em>{maxNow}</em> 件事</h1>
                  <p>{inProgress} 件正在进行，{waiting} 件正在等待；项目、任务、Agent 更新、问题与回执来自同一份 Base。</p>
                </div>
                <div className="orientation-metrics">
                  <div><span>进行中</span><strong>{inProgress}</strong><small>现在正在做</small></div>
                  <div><span>项目</span><strong>{activeProjects}</strong><small>仍有进行项</small></div>
                  <div><span>正在等</span><strong>{waiting}</strong><small>外部或反馈</small></div>
                  <button type="button" onClick={() => setTab("completed")}><span>已完成</span><strong>{completed}</strong><small>集中查看 →</small></button>
                </div>
              </section>

              <div className="today-grid">
                <section className="panel focus-panel">
                  <header className="panel-head"><div><span>我的处理队列</span><h2>最值得推进</h2></div><small>最多 4 件</small></header>
                  <div className="focus-list">
                    {attentionTasks.map((task, index) => (
                      <button className={`focus-item ${selectedTask?.id === task.id ? "selected" : ""}`} type="button" key={task.id} onClick={() => selectTask(task, task.project.id)}>
                        <b>{String(index + 1).padStart(2, "0")}</b>
                        <div><strong>{task.title}</strong><small>{task.project.shortName} · {task.relation}</small></div>
                        <span className={`stage stage-${stageOf(task)}`}>{stageCopy[stageOf(task)]}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="panel project-detail" style={{ "--accent": selectedProject?.accent ?? "#3f63f2" } as CSSProperties}>
                  <header className="panel-head"><div><span>当前项目</span><h2>{selectedProject?.shortName}</h2></div><strong>{selectedProject ? projectProgress(selectedProject) : 0}%</strong></header>
                  <p className="project-goal">{selectedProject?.goal}</p>
                  <div className="progress-track"><i style={{ width: `${selectedProject ? projectProgress(selectedProject) : 0}%` }} /></div>
                  <div className="task-list">
                    {selectedProject?.tasks.filter((task) => !["done", "abandoned"].includes(stageOf(task))).slice(0, 5).map((task) => (
                      <button className={selectedTask?.id === task.id ? "selected" : ""} type="button" key={task.id} onClick={() => selectTask(task)}>
                        <i className={`task-dot dot-${stageOf(task)}`}>{stageOf(task) === "done" ? "✓" : ""}</i>
                        <span><strong>{task.title}</strong><small>{task.owner === "Agent" ? task.relation : task.owner === "一起" ? `共同推进 · ${task.relation}` : `我来 · ${task.relation}`}</small></span>
                        <em>{stageCopy[stageOf(task)]}</em>
                      </button>
                    ))}
                  </div>
                </section>
              </div>

              <section className="portfolio-row">
                <header className="section-title"><div><span>全部项目</span><h2>所有进行项</h2></div><button type="button" onClick={() => setTab("projects")}>打开项目页 →</button></header>
                <div className="project-cards">
                  {projects.filter((project) => project.tasks.some((task) => !["done", "abandoned"].includes(stageOf(task)))).map((project) => {
                    const progress = projectProgress(project);
                    const next = project.tasks.find((task) => !["done", "abandoned"].includes(stageOf(task)));
                    return (
                      <button className={selectedProject?.id === project.id ? "selected" : ""} type="button" key={project.id} onClick={() => selectProject(project)} style={{ "--accent": project.accent } as CSSProperties}>
                        <span>{project.code}</span><strong>{project.shortName}</strong><small>{project.due}</small>
                        <div><i style={{ width: `${progress}%` }} /></div>
                        <p>{next ? `下一步：${next.title}` : "当前已完成"}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            </>
          )}

          {tab === "projects" && (
            <section className="projects-page">
              <header className="page-heading"><span>飞书任务深潜</span><h1>一件事的来龙去脉，都在这里</h1><p>从飞书任务进入后，Agent 运行、产物、回复和回执共用同一个任务身份。</p></header>
              <div className="project-room-layout">
                <aside className="project-switcher" aria-label="项目列表">
                  <header><span>全部项目</span><small>{projects.length} 个</small></header>
                  {projects.map((project) => {
                    const next = project.tasks.find((task) => !["done", "abandoned"].includes(stageOf(task)));
                    const blocked = project.tasks.filter((task) => stageOf(task) === "waiting").length;
                    return (
                      <button type="button" className={selectedProject?.id === project.id ? "selected" : ""} key={project.id} onClick={() => selectProject(project)} style={{ "--accent": project.accent } as CSSProperties}>
                        <span>{project.code}</span><strong>{project.shortName}</strong>
                        <p>{next ? next.title : "这个项目已完成"}</p>
                        <footer><b>{projectProgress(project)}%</b><small>{blocked ? `${blocked} 件正在等` : project.due}</small></footer>
                      </button>
                    );
                  })}
                </aside>

                <section className="project-room" style={{ "--accent": selectedProject?.accent ?? "#3f63f2" } as CSSProperties}>
                  <header className="project-room-head">
                    <div><span>{selectedProject?.code}</span><h2>{selectedProject?.name}</h2><p>{selectedProject?.goal}</p></div>
                    <div className="room-progress"><b>{selectedProject ? projectProgress(selectedProject) : 0}%</b><small>{selectedProject?.due}</small></div>
                  </header>
                  <div className="room-progress-track"><i style={{ width: `${selectedProject ? projectProgress(selectedProject) : 0}%` }} /></div>

                  <div className="project-room-body">
                    <aside className="room-task-list">
                      <header><span>任务</span><small>{selectedProject?.tasks.length ?? 0} 件</small></header>
                      {selectedProject?.tasks.map((task) => (
                        <button className={selectedTask?.id === task.id ? "selected" : ""} type="button" key={task.id} onClick={() => selectTask(task)}>
                          <i className={`task-dot dot-${stageOf(task)}`}>{stageOf(task) === "done" ? "✓" : ""}</i>
                          <span><strong>{task.title}</strong><small>{task.relation}</small></span>
                          <em>{stageCopy[stageOf(task)]}</em>
                        </button>
                      ))}
                    </aside>

                    {selectedTask && (
                      <section className="task-run-room">
                        <header className="task-room-head">
                          <div><span>当前任务</span><h3>{selectedTask.title}</h3><p>{selectedTask.project.shortName} · {selectedTask.relation}</p></div>
                          <b className={`stage stage-${stageOf(selectedTask)}`}>{stageCopy[stageOf(selectedTask)]}</b>
                        </header>

                        <div className="run-spine">
                          <article>
                            <i>01</i><div><span>{dataMode === "feishu" ? "FRESH COPY · FEISHU LIVE" : showcaseDemo ? "DEMO DATA" : "PREVIEW"}</span><h4>任务与项目真源</h4><p>{dataMode === "feishu" ? "这条任务、五态和项目归属直接来自同一份飞书 Base；本页不另存任务。" : showcaseDemo ? "这是一条虚构任务，用来演示真实交互结构。" : "当前是本地预览；没有冒充真实飞书写回。"}</p><code>{selectedTask.id}</code></div>
                          </article>
                          <article>
                            <i>02</i><div><span>{selectedRun?.agentName ?? "AGENT 更新"}</span><h4>{selectedAgentUpdates.length ? `${selectedAgentUpdates.length} 条真实运行更新` : selectedRun?.status ?? "暂无绑定运行"}</h4>
                              {selectedAgentUpdates.length ? (
                                <div className="run-events">{selectedAgentUpdates.map((event) => <p key={event.id}><time>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.occurredAt))}</time><b>{event.title}</b><small>{event.detail}</small></p>)}</div>
                              ) : selectedRun ? (
                                <div className="run-events">{selectedRun.events.map((event) => <p key={`${event.time}-${event.label}`}><time>{event.time}</time><b>{event.label}</b><small>{event.detail}</small></p>)}</div>
                              ) : <p>Connector 的 start / progress / report / incident 会从 Agent 事件表回到这里。</p>}
                            </div>
                          </article>
                          <article>
                            <i>03</i><div><span>问题 / 反馈</span><h4>{selectedIssues.length ? `${selectedIssues.length} 条需求、问题或回复` : "等待问题或需求"}</h4>
                              {selectedIssues.length ? <div className="signal-stack">{selectedIssues.map((signal) => <section key={signal.id}><header><b>{signal.title}</b><em>{signal.status}</em></header><p>{signal.detail}</p></section>)}</div> : <p>你用“问问 AI”新增的需求、Agent 提问和人工回复都按 task_id 回到当前任务。</p>}
                            </div>
                          </article>
                          <article className="artifact-step">
                            <i>04</i><div><span>产物 / 回执</span><h4>{selectedArtifacts.length ? `${selectedArtifacts.length} 条产物与 receipt` : selectedRun?.artifact?.title ?? "等待真实产物"}</h4>
                              {selectedArtifacts.length ? <div className="signal-stack">{selectedArtifacts.map((signal) => <section key={signal.id}><header><b>{signal.title}</b><em>{signal.status}</em></header><p>{signal.detail}</p>{signal.receiptId && <code>{signal.receiptId}</code>}{signal.artifactUrl?.startsWith("http") && <a href={signal.artifactUrl} target="_blank" rel="noreferrer">打开产物 →</a>}</section>)}</div> : <p>{selectedRun?.artifact?.summary ?? "Connector 的 artifact / finish 回写会出现在这里；本机工程文件不会上传飞书。"}</p>}
                            </div>
                          </article>
                          <article className="ai-handoff-step">
                            <i>05</i><div><span>{askAiHandoffUrl ? "飞书原生自然语言入口" : "接入你自己的数据与 Agent"}</span><h4>{askAiHandoffUrl ? "到同一份 Base 里问问 AI" : "让每个 Agent 读写同一套飞书数据"}</h4><p>{askAiHandoffUrl ? "按 ⌘/Ctrl + K 打开同一 Base，再点右上角“问问 AI”；查询、创建需求和后续处理都交给飞书。" : "飞书五张表做唯一真源；Connector 让 Codex、Claude 或其他 Agent 读取任务，并回报进度、问题、产物和回执。"}</p><button type="button" onClick={askAiHandoffUrl ? openAskAi : openFeishuSetup}>{askAiHandoffUrl ? "打开飞书 Base →" : "查看接入方式 →"}</button></div>
                          </article>
                        </div>

                        {freshBase ? <div className="fresh-base-write-note"><b>状态仍由 Base / Connector 维护</b><span>项目房间只读真实投影，不在这里建立第二套任务状态。</span></div> : <details className="task-details">
                          <summary>任务状态操作 · {boundary.actionSuffix}</summary>
                          <div>{(["todo", "running", "waiting", "done", "abandoned"] as TaskStage[]).map((stage) => <button type="button" key={stage} className={stageOf(selectedTask) === stage ? "active" : ""} disabled={updating} onClick={() => void setSelectedTaskStage(stage)}>{stageCopy[stage]}</button>)}</div>
                        </details>}
                      </section>
                    )}
                  </div>
                </section>
              </div>
            </section>
          )}

          {tab === "updates" && (
            <section className="updates-page">
              <header className="page-heading"><span>工作动态</span><h1>谁更新了什么，为什么</h1><p>活跃不等于进展。这里只记录影响工作的变化。</p></header>
              <div className="updates-layout">
                <div className="update-feed">
                  {!freshBase && updates.map((update) => (
                    <article key={update.id} className={update.receipt === "failed" ? "failed" : ""}>
                      <time>{update.time}</time>
                      <div className="update-mark"><i /></div>
                      <div>
                        <span>{update.project}</span><h3>{update.task}</h3>
                        <p><b>{update.from}</b><i>→</i><b>{update.to}</b></p>
                        <small>{update.initiatedBy} 发起 · {update.executedBy} 执行</small>
                        <blockquote>“{update.reason}”</blockquote>
                        <code>{update.receipt}</code>
                      </div>
                    </article>
                  ))}
                  {projectSignals.map((signal) => (
                    <article key={signal.id} className={signal.category === "incident" ? "failed" : ""}>
                      <time>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(signal.occurredAt))}</time>
                      <div className="update-mark"><i /></div>
                      <div>
                        <span>{signal.agentName ?? signal.category}</span><h3>{signal.title}</h3>
                        <small>{signal.category} · {signal.status}</small>
                        <blockquote>{signal.detail}</blockquote>
                        {signal.receiptId && <code>{signal.receiptId}</code>}
                      </div>
                    </article>
                  ))}
                  {sourceEvents.slice(0, 5).map((event) => (
                    <article key={event.id}>
                      <time>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.occurredAt))}</time>
                      <div className="update-mark"><i /></div>
                      <div><span>{event.actor}</span><h3>{event.title}</h3><small>{event.status}</small><blockquote>{event.detail}</blockquote></div>
                    </article>
                  ))}
                </div>
                <aside className="audit-explainer">
                  <span>更新记录</span><h2>每次变化都留四样东西</h2>
                  <ol><li><b>谁说的</b><small>你或哪个 Agent</small></li><li><b>谁执行的</b><small>OPS、飞书或具体 Agent</small></li><li><b>为什么改</b><small>保留原话与依据</small></li><li><b>改成什么</b><small>状态变化与回执编号</small></li></ol>
                </aside>
              </div>
            </section>
          )}

          {tab === "completed" && (
            <section className="completed-page">
              <header className="page-heading completed-heading">
                <div><span>已完成</span><h1>做完的事集中放这里</h1><p>{completed} 件完成项，不再挤占今天的注意力。</p></div>
                <button type="button" onClick={() => setTab("today")}>← 返回今天</button>
              </header>
              <div className="completed-groups">
                {projects.map((project) => {
                  const projectDone = project.tasks.filter((task) => stageOf(task) === "done");
                  if (!projectDone.length) return null;
                  return (
                    <section className="completed-group" key={project.id} style={{ "--accent": project.accent } as CSSProperties}>
                      <header><div><span>{project.code}</span><h2>{project.shortName}</h2></div><b>{projectDone.length} 件</b></header>
                      <div>
                        {projectDone.map((task) => (
                          <button type="button" key={task.id} onClick={() => { selectTask(task, project.id); setTab("projects"); }}>
                            <i>✓</i><span><strong>{task.title}</strong><small>{task.relation} · {task.owner === "Agent" ? "Agent 更新" : task.owner}</small></span><em>查看项目 →</em>
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
                {!completedTasks.length && <p className="completed-empty">还没有完成项。做完的事会自动收进这里。</p>}
              </div>
            </section>
          )}
        </main>

        {tab !== "projects" && <aside className="agent-dock">
          <header><div><span>Agent 进度</span><h2>谁在做什么</h2></div><small>{agentCards.filter((agent) => agent.run?.stage !== "done").length} 个有进行项</small></header>
          <p className="dock-note">这里只显示工作变化，不把“在线”当成进度。</p>
          <div className="agent-list">
            {agentCards.map((agent) => (
              <button type="button" key={agent.id} className={agent.run?.stage === "review" || agent.unread ? "needs-read" : ""} onClick={() => {
                if (agent.task) selectTask(agent.task, agent.task.project.id);
                setTab("today");
              }} style={{ "--agent": agent.color } as CSSProperties}>
                <b>{agent.mark}</b>
                <span><strong>{agent.name}</strong><small>{agent.run?.status ?? "暂无进行中的工作"}</small><em>{agent.task?.project.shortName ?? "等待任务"} · {agent.run?.eta ?? "没有新更新"}</em></span>
                {agent.unread > 0 && <i>{agent.unread}</i>}
              </button>
            ))}
            {!agentCards.length && <p className="agent-empty">还没有 Agent 更新。你仍然可以独自使用项目和任务。</p>}
          </div>

          {selectedTask && (
            <section className="selected-task-card">
              <span>当前选中</span><h3>{selectedTask.title}</h3><p>{selectedTask.project.shortName} · {selectedTask.relation}</p>
              {!freshBase && <div>
                {(["todo", "running", "waiting", "done", "abandoned"] as TaskStage[]).map((stage) => (
                  <button type="button" key={stage} className={stageOf(selectedTask) === stage ? "active" : ""} disabled={updating} onClick={() => void setSelectedTaskStage(stage)}>{stageCopy[stage]}</button>
                ))}
              </div>}
              {freshBase && <button className="selected-ask-ai" type="button" onClick={openAskAi}>用「问问 AI」查询或新增需求 →</button>}
            </section>
          )}

          {selectedTask && selectedMessages.length > 0 && (
            <section className="agent-relay">
              <header><span>这件事的对话</span><small>{selectedMessages.length} 条</small></header>
              <div className="relay-thread">
                {selectedMessages.map((message) => (
                  <article className={message.direction === "to_max" ? "from-agent" : "from-max"} key={message.message_id}>
                    <b>{message.direction === "to_max" ? runs.find((run) => run.agentId === message.agent_id)?.agentName ?? message.agent_id : "你"}</b>
                    <p>{message.body}</p>
                    <small>{message.direction === "to_max" && message.status === "pending" ? "等我回复" : messageStatusCopy[message.status]}</small>
                  </article>
                ))}
              </div>
              {pendingQuestion && !freshBase && (
                <div className="relay-reply">
                  <textarea value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} placeholder="直接回复这个 Agent…" />
                  <button type="button" disabled={!replyDraft.trim() || replying} onClick={() => void replyToAgent()}>{replying ? "正在发送…" : `回复 Agent · ${boundary.actionSuffix}`}</button>
                  {replyError && <small className="relay-error">{replyError}</small>}
                </div>
              )}
              {freshBase && <button className="relay-ai-handoff" type="button" onClick={openAskAi}>回到同一 Base 回复或补充需求 →</button>}
              {!pendingQuestion && selectedMessages.some((message) => message.status === "acknowledged") && (
                <footer><i>✓</i><span>你已回复，Agent 已收到并确认</span>{selectedMessageReceipt && <code>{selectedMessageReceipt.receipt_id}</code>}</footer>
              )}
            </section>
          )}

          <section className="latest-receipt">
            <span>最近更新记录</span>
            {freshBase && projectSignals[0] ? <><p>{projectSignals[0].title}</p><div><b>{projectSignals[0].category}</b><i>·</i><b>{projectSignals[0].status}</b></div><small>{projectSignals[0].agentName ?? "飞书 Base"} · 同一任务链</small>{projectSignals[0].receiptId && <code>{projectSignals[0].receiptId}</code>}</> : <><p>{updates[0]?.task}</p><div><b>{updates[0]?.from}</b><i>→</i><b>{updates[0]?.to}</b></div><small>{updates[0]?.initiatedBy} 发起 · {updates[0]?.executedBy}</small><code>{updates[0]?.receipt}</code></>}
          </section>
        </aside>}
      </div>

      <footer className="status-bar">
        <div className="status-source"><i className={`mode-${dataMode}`} /><span>{syncDetail}</span></div>
        <button className="ai-entry" type="button" aria-label={askAiHandoffUrl ? "打开同一 Base 的飞书 AI" : "接入飞书数据与 Agent"} onClick={askAiHandoffUrl ? openAskAi : openFeishuSetup}>
          <b>AI</b><span><strong>{askAiHandoffUrl ? "去飞书「问问 AI」" : "接入飞书数据与 Agent"}</strong><small>{askAiHandoffUrl ? "打开同一 Base · 查询、创建需求和处理都交给飞书" : "授权一次，自动绑定 Base、看板和 Agent"}</small></span><kbd>⌘ K</kbd>
        </button>
        <small aria-label="Base 是唯一真源；PREVIEW 不触碰真实飞书"><b>{boundary.label}</b> · {askAiHandoffUrl ? "仪表盘留在这里；实际处理回到飞书" : boundary.mode === "live" ? "写回同一份飞书任务并保留来源" : "仅改当前预览，不触碰真实飞书"}</small>
      </footer>

      {composerOpen && selectedTask && !freshBase && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="composer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setComposerOpen(false); }}>
          <section className="ai-composer" role="dialog" aria-modal="true" aria-labelledby="composer-title">
            <header><div><span>{boundary.label} · AI 帮你更新</span><h2 id="composer-title">一句话更新进度</h2></div><button type="button" aria-label="关闭" onClick={() => setComposerOpen(false)}>×</button></header>
            <div className="composer-target"><small>将更新</small><strong>{selectedTask.title}</strong><span>{selectedTask.project.shortName} · 当前{stageCopy[stageOf(selectedTask)]}</span></div>
            <label><span>刚刚发生了什么？</span><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="例如：Codex 做完了，我已经看过，这一版可以，标记完成。" /></label>
            <div className="example-chips">
              <button type="button" onClick={() => setComposer("我已经看过这一版了，可以，任务完成")}>我看过了，完成</button>
              <button type="button" onClick={() => setComposer("这个正在继续做，保持进行中")}>继续进行</button>
              <button type="button" onClick={() => setComposer("现在卡在外部回复，先标记等待")}>正在等待</button>
            </div>
            {composer.trim() && <div className="change-preview"><span>准备更新</span><strong>{stageCopy[stageOf(selectedTask)]} <i>→</i> {stageCopy[inferStage(composer)]}</strong><small>依据：你刚刚的原话 · 更新后保留回执</small></div>}
            <footer><button type="button" onClick={() => setComposerOpen(false)}>取消</button><button type="button" disabled={!composer.trim() || updating} onClick={() => void applyStatusUpdate()}>{updating ? "正在写回…" : dataMode === "feishu" ? "更新飞书状态" : "更新预览状态"} →</button></footer>
          </section>
        </div>
      )}
      {feishuSetupOpen && !freshBase && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="composer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFeishuSetupOpen(false); }}>
          <section className="feishu-setup" role="dialog" aria-modal="true" aria-labelledby="feishu-setup-title">
            <header><div><span>INSTALL OPS IN FEISHU</span><h2 id="feishu-setup-title">两步，开始带着 Agent 做事</h2><p>不用懂多维表格。先让飞书创建你的工作台，再把一句话发给你的 Agent。</p></div><button type="button" aria-label="关闭接入向导" onClick={() => setFeishuSetupOpen(false)}>×</button></header>

            <div className="feishu-install-summary" aria-label="安装后自动完成的内容">
              <div><i>01</i><span><b>飞书建好工作台</b><small>今天、项目、动态都已排好</small></span></div>
              <div><i>02</i><span><b>Agent 自动报到</b><small>你来命名，不填机器 ID</small></span></div>
              <div><i>03</i><span><b>以后只说人话</b><small>进度、问题、产物写回同一处</small></span></div>
            </div>

            <div className="feishu-install-grid">
              <section className="feishu-install-primary">
                <div className="feishu-step-label"><b>STEP 1</b><span>{installWorkspace ? "已安装到你的飞书" : installStatus.label}</span></div>
                <div className="feishu-install-title"><i aria-hidden="true">飞</i><div><h3>在飞书里创建我的 OPS</h3><p>登录并授权后，自动创建一份只属于你的工作台和底层数据表。模板已经排好，不需要你搭表。</p></div></div>
                {installWorkspace ? <a className="feishu-login-button" href={installWorkspace.links.feishu} target="_blank" rel="noreferrer"><span>打开我的飞书工作区</span><i>↗</i></a> : <button type="button" className="feishu-login-button" onClick={beginFeishuInstallation}><span>用飞书登录并创建</span><i>→</i></button>}
                <ul>
                  <li><i>✓</i><span>飞书是唯一数据源</span></li>
                  <li><i>✓</i><span>不上传你的本机工程文件</span></li>
                  <li><i>✓</i><span>飞书 AI 负责问答、整理和新增记录</span></li>
                </ul>
              </section>

              <section className="feishu-agent-pairing">
                <div className="feishu-step-label"><b>STEP 2</b><span>安装后生成一次性配对链接</span></div>
                <h3>给这个 Agent 起个名字</h3>
                <label><span>显示名称</span><input type="text" value={feishuAgentName} maxLength={40} onChange={(event) => { setFeishuAgentName(event.target.value); setAgentInstructionCopied(false); setPairingInstruction(null); }} placeholder="例如：Codex、研究员、前端搭档" /></label>
                <div className="agent-pairing-preview">
                  <span>发给 Agent 的一句话</span>
                  <p>{agentPairingInstruction}</p>
                  <small>完成飞书安装后，OPS 会把真实的一次性配对链接自动放进这句话。</small>
                </div>
                <button type="button" className="copy-agent-instruction" disabled={!installWorkspace || pairingBusy} onClick={() => void copyAgentPairingInstruction()}>{pairingBusy ? "正在生成一次性链接…" : agentInstructionCopied ? "已复制这句话 ✓" : installWorkspace ? "生成并复制给 Agent" : "完成飞书安装后可生成"}</button>
              </section>
            </div>

            <div className="agent-roster-preview">
              <header><div><b>{installWorkspace ? "我的 Agent 名册" : "接入后，你会在飞书看到谁正在做什么"}</b><small>Agent 首次真实写回后会显示连接状态和 receipt</small></div><span>{installWorkspace ? `${installWorkspace.agents.filter((agent) => !agent.revoked).length} AGENTS` : "ROSTER PREVIEW"}</span></header>
              {installWorkspace ? <div>
                {installWorkspace.agents.filter((agent) => !agent.revoked).map((agent) => <article key={agent.id}><i style={{ "--agent": "#3f63f2" } as CSSProperties}>{agent.name.slice(0, 2).toUpperCase()}</i><span><b>{agent.name}</b><small>{agent.receipt ? `首条回执 ${agent.receipt}` : "等待连接测试 progress"}</small></span><div className="roster-agent-actions"><em>{agent.connected ? "已连接" : "待自检"}</em><button type="button" onClick={() => void revokeInstalledAgent(agent.id)}>撤销</button></div></article>)}
                <article className="roster-add"><i>＋</i><span><b>继续接入 Agent</b><small>每个 Agent 都可以单独命名和撤销</small></span></article>
              </div> : <div><article><i style={{ "--agent": "#3f63f2" } as CSSProperties}>CO</i><span><b>Codex</b><small>正在整理评委演示路径</small></span><em>工作中</em></article><article><i style={{ "--agent": "#b45a42" } as CSSProperties}>CL</i><span><b>Claude</b><small>等待下一条任务</small></span><em>在线</em></article><article className="roster-add"><i>＋</i><span><b>继续接入 Agent</b><small>每个 Agent 都可以单独命名</small></span></article></div>}
            </div>

            {feishuSetupError && <p className="feishu-setup-error" role="alert">{feishuSetupError}</p>}

            <details className="feishu-existing-setup">
              <summary>我已经有 OPS Base，或想使用完全不托管的技术方式</summary>
              <div><p>已有 Base 可以只保存快捷入口；这不是数据授权。完全不托管也可以，但首次需要自己创建飞书自建应用并在本机配置 Connector，不作为新手默认路径。</p><label><span>你的飞书 Base 链接</span><input type="url" value={feishuSetupDraft} onChange={(event) => { setFeishuSetupDraft(event.target.value); setFeishuSetupError(""); }} placeholder="https://example.feishu.cn/base/BASE_TOKEN" /></label><div className="existing-actions"><a href={MAXOPS_CONNECTOR_URL} target="_blank" rel="noreferrer">查看技术版 Connector →</a><button type="button" disabled={!feishuSetupDraft.trim()} onClick={saveFeishuSetup}>保存快捷入口</button></div></div>
            </details>

            <p className="feishu-setup-boundary"><b>{installWorkspace ? "你的工作区已由同一份 Base 驱动。" : installStatus.state === "ready" ? "当前展示的是脱敏预览。" : "安装服务暂未开放。"}</b>{installWorkspace ? "现在只需命名 Agent，并把生成的一句话发给它；一次性代码用后即失效。" : installStatus.state === "ready" ? "点击飞书授权后，系统会在你的账号中创建 Base，并把漂亮看板自动绑定到同一份数据；不需要复制链接或选择数据源。" : "页面保持失败关闭，不会用演示数据冒充真实安装。稍后重试即可。"}</p>
            <footer>{installWorkspace ? <button type="button" className="forget-feishu" onClick={() => void revokeInstallation()}>撤销 OPS（保留 Base）</button> : personalFeishuBaseUrl ? <button type="button" className="forget-feishu" onClick={forgetFeishuSetup}>移除此设备上的快捷入口</button> : <span />}<div><button type="button" onClick={() => setFeishuSetupOpen(false)}>先看看产品</button></div></footer>
          </section>
        </div>
      )}
      </div>
    </div>
  );
}
