import { execFileSync, spawnSync } from "node:child_process";
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateConnectorConfig } from "./feishu-long-connection.mjs";

export const SERVICE_LABEL = "com.max.maxops-feishu-long-connection";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = resolve(scriptDirectory, "..");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringNode(value) {
  return `<string>${xmlEscape(value)}</string>`;
}

export function servicePaths({ home = homedir(), projectRoot = defaultProjectRoot } = {}) {
  // Compatibility path: existing connector installs already store private
  // state here. The user-facing product name is OPS, but this path is stable.
  const supportDirectory = resolve(home, "Library", "Application Support", "MAX OPS");
  const logDirectory = resolve(home, "Library", "Logs", "OPS");
  return {
    projectRoot,
    connectorScript: resolve(projectRoot, "scripts", "feishu-long-connection.mjs"),
    configPath: resolve(supportDirectory, "feishu-long-connection.json"),
    healthPath: resolve(supportDirectory, "feishu-long-connection-health.json"),
    plistPath: resolve(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    stdoutPath: resolve(logDirectory, "feishu-long-connection.log"),
    stderrPath: resolve(logDirectory, "feishu-long-connection.error.log"),
    supportDirectory,
    logDirectory,
  };
}

export function renderLaunchAgentPlist({ paths, nodePath }) {
  const environment = {
    MAXOPS_FEISHU_CONNECTOR_CONFIG: paths.configPath,
    MAXOPS_FEISHU_HEALTH_PATH: paths.healthPath,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  };
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      ${stringNode(value)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringNode(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${stringNode(nodePath)}
    ${stringNode(paths.connectorScript)}
  </array>
  <key>WorkingDirectory</key>
  ${stringNode(paths.projectRoot)}
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${stringNode(paths.stdoutPath)}
  <key>StandardErrorPath</key>
  ${stringNode(paths.stderrPath)}
</dict>
</plist>
`;
}

async function ensurePrivateConfig(configPath) {
  const metadata = await lstat(configPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Connector config must be a regular file");
  if (metadata.uid !== process.getuid()) throw new Error("Connector config must be owned by the current user");
  if ((metadata.mode & 0o077) !== 0) throw new Error("Connector config permissions must be 0600 or stricter");
  validateConnectorConfig(JSON.parse(await readFile(configPath, "utf8")));
  return metadata;
}

async function atomicPrivateWrite(targetPath, contents) {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(targetPath), 0o700);
  const temporaryPath = `${targetPath}.tmp.${process.pid}`;
  await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function launchDomain() {
  return `gui/${process.getuid()}`;
}

function launchTarget() {
  return `${launchDomain()}/${SERVICE_LABEL}`;
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} failed`).trim());
  }
  return result;
}

async function nodePath() {
  const candidates = [process.execPath, "/opt/homebrew/bin/node", "/usr/local/bin/node"];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit path. launchd does not inherit the interactive shell PATH.
    }
  }
  throw new Error("No executable Node.js runtime found");
}

export async function configure(paths, input) {
  const config = validateConnectorConfig(JSON.parse(input));
  await atomicPrivateWrite(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return paths.configPath;
}

export async function install(paths) {
  await ensurePrivateConfig(paths.configPath);
  await access(paths.connectorScript, fsConstants.R_OK);
  await mkdir(dirname(paths.plistPath), { recursive: true });
  await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.supportDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.logDirectory, 0o700);
  await chmod(paths.supportDirectory, 0o700);
  const plist = renderLaunchAgentPlist({ paths, nodePath: await nodePath() });
  const temporaryPath = `${paths.plistPath}.candidate.${process.pid}`;
  await writeFile(temporaryPath, plist, { mode: 0o600, flag: "wx" });
  execFileSync("/usr/bin/plutil", ["-lint", temporaryPath], { stdio: "pipe" });
  runLaunchctl(["bootout", launchTarget()], { allowFailure: true });
  try {
    runLaunchctl(["bootstrap", launchDomain(), temporaryPath]);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    try {
      await access(paths.plistPath, fsConstants.R_OK);
      runLaunchctl(["bootstrap", launchDomain(), paths.plistPath]);
    } catch {
      // There was no previous service to restore, or its own plist was invalid.
    }
    throw error;
  }
  await rename(temporaryPath, paths.plistPath);
  await chmod(paths.plistPath, 0o600);
  runLaunchctl(["kickstart", "-k", launchTarget()]);
}

export async function status(paths) {
  const service = runLaunchctl(["print", launchTarget()], { allowFailure: true });
  let health = null;
  try {
    health = JSON.parse(await readFile(paths.healthPath, "utf8"));
  } catch {
    // A missing health file is expected before the first successful start.
  }
  return {
    loaded: service.status === 0,
    running: service.status === 0 && /\bstate = running\b/.test(service.stdout),
    launchctl: service.status === 0 ? service.stdout : null,
    health,
  };
}

export async function doctor(paths) {
  const checks = [];
  async function check(name, action) {
    try {
      await action();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, message: error instanceof Error ? error.message : "Unknown error" });
    }
  }
  await check("node", nodePath);
  await check("connector_script", () => access(paths.connectorScript, fsConstants.R_OK));
  await check("private_config", () => ensurePrivateConfig(paths.configPath));
  await check("launch_agent", async () => {
    await access(paths.plistPath, fsConstants.R_OK);
    execFileSync("/usr/bin/plutil", ["-lint", paths.plistPath], { stdio: "pipe" });
  });
  const current = await status(paths);
  checks.push({ name: "service_loaded", ok: current.loaded });
  checks.push({ name: "service_running", ok: current.running });
  checks.push({ name: "connection_health", ok: current.health?.state === "connected", message: current.health?.state || "missing" });
  return checks;
}

async function uninstall(paths, { removeConfig = false } = {}) {
  runLaunchctl(["bootout", launchTarget()], { allowFailure: true });
  await rm(paths.plistPath, { force: true });
  await rm(paths.healthPath, { force: true });
  if (removeConfig) await rm(paths.configPath, { force: true });
}

function printStatus(result) {
  const summary = {
    loaded: result.loaded,
    running: result.running,
    state: result.health?.state || "unknown",
    pid: result.health?.pid || null,
    updated_at: result.health?.updated_at || null,
    connected_at: result.health?.reconnected_at || result.health?.connected_at || null,
    last_error: result.health?.last_error || null,
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "status";
  const paths = servicePaths();
  if (command === "configure") {
    if (process.stdin.isTTY) throw new Error("Pass the connector JSON through stdin so secrets do not enter argv or shell history");
    await configure(paths, await readStdin());
    console.log(`Private connector config written: ${paths.configPath}`);
    return;
  }
  if (command === "install") {
    await install(paths);
    printStatus(await status(paths));
    return;
  }
  if (command === "restart") {
    runLaunchctl(["kickstart", "-k", launchTarget()]);
    printStatus(await status(paths));
    return;
  }
  if (command === "status") {
    printStatus(await status(paths));
    return;
  }
  if (command === "doctor") {
    const checks = await doctor(paths);
    console.log(JSON.stringify(checks, null, 2));
    if (checks.some((item) => !item.ok)) process.exitCode = 1;
    return;
  }
  if (command === "uninstall") {
    await uninstall(paths, { removeConfig: argv.includes("--remove-config") });
    console.log(`Unloaded ${SERVICE_LABEL}; private config ${argv.includes("--remove-config") ? "removed" : "preserved"}.`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown service-manager error");
    process.exitCode = 1;
  });
}
