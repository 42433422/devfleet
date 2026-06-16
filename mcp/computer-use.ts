import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TRAE_BUNDLE_NAMES = [
  'Trae CN.app',
  'TRAE SOLO CN.app',
  'Trae.app',
  'TRAE SOLO.app',
] as const;

/** macOS 上 Trae 进程名候选；TRAE CN 为 Trae CN 中国区常见进程名。 */
export const TRAE_PROCESS_NAMES = [
  'TRAE CN',
  'Trae CN',
  'TRAE SOLO CN',
  'TRAE SOLO',
  'Trae',
] as const;

export const resolveComputerUseScript = (): string => {
  if (process.env.DEVFLEET_COMPUTER_USE_SCRIPT) {
    const override = process.env.DEVFLEET_COMPUTER_USE_SCRIPT;
    if (existsSync(override)) return override;
    throw new Error(`DEVFLEET_COMPUTER_USE_SCRIPT 不存在: ${override}`);
  }

  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'trae-new-task.ps1');
  if (existsSync(bundled)) return bundled;

  const dev = resolve('scripts/computer-use/trae-new-task.ps1');
  if (existsSync(dev)) return dev;

  throw new Error('未找到 trae-new-task.ps1 控制脚本');
};

export const traeApplicationNameFromBundle = (appBundlePath: string): string =>
  basename(appBundlePath).replace(/\.app$/i, '');

const traeBundleAt = (parent: string, name: string) => {
  const candidate = join(parent, name);
  return existsSync(candidate) ? candidate : null;
};

export const findTraeAppBundle = (): string | null => {
  const candidates = [
    '/Applications/Trae CN.app',
    '/Applications/TRAE SOLO CN.app',
    '/Applications/Trae.app',
    '/Applications/TRAE SOLO.app',
    '/Volumes/Trae CN/Trae CN.app',
    '/Volumes/TRAE Work CN/TRAE SOLO CN.app',
    '/Volumes/TRAE Work/TRAE SOLO.app',
  ];
  const direct = candidates.find((candidate) => existsSync(candidate));
  if (direct) return direct;

  try {
    for (const volume of readdirSync('/Volumes')) {
      const volumeRoot = join('/Volumes', volume);
      for (const name of TRAE_BUNDLE_NAMES) {
        const nested = traeBundleAt(volumeRoot, name);
        if (nested) return nested;
        try {
          for (const child of readdirSync(volumeRoot)) {
            const deep = traeBundleAt(join(volumeRoot, child), name);
            if (deep) return deep;
          }
        } catch {
          // 跳过非目录卷宗条目。
        }
      }
    }
  } catch {
    // 非 macOS 或 /Volumes 不可读。
  }
  return null;
};

export const resolveTraeCli = (appBundlePath: string): string | null => {
  const binDir = join(appBundlePath, 'Contents/Resources/app/bin');
  for (const name of ['trae-cn', 'trae', 'code', 'marscode']) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const appleScriptString = (value: string) => {
  const parts: string[] = [];
  let current = '';
  const pushCurrent = () => {
    if (!current) return;
    parts.push(`"${current.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    current = '';
  };
  for (const char of value) {
    if (char === '\n') {
      pushCurrent();
      parts.push('linefeed');
    } else if (char !== '\r') {
      current += char;
    }
  }
  pushCurrent();
  return parts.length > 0 ? parts.join(' & ') : '""';
};

export const workspaceFolderName = (workspacePath: string): string => {
  const normalized = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = basename(normalized);
  return base && base !== '.' && base !== '/' ? base : 'devfleet';
};

export const workspaceWindowNeedles = (workspacePath: string): string[] => {
  const needles: string[] = [];
  const normalized = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = basename(normalized);
  const parent = basename(dirname(normalized));
  if (base && base !== '.' && base !== '/') needles.push(base);
  if (parent && !['.', 'tmp', 'private', 'var', 'Volumes'].includes(parent)) needles.push(parent);
  needles.push(normalized);
  for (const segment of ['/agent-workspace/', '/devfleet-e2e/']) {
    const idx = normalized.indexOf(segment);
    if (idx >= 0) {
      const tail = normalized.slice(idx + segment.length);
      const token = tail.split('/')[0];
      if (token) needles.push(token);
    }
  }
  return [...new Set(needles)];
};

const buildTraeWindowMatchBlock = (folderName: string, applicationName: string) => {
  const escapedFolder = folderName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedApp = applicationName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `set workspaceFolderName to "${escapedFolder}"
        set traeAppTitle to "${escapedApp}"
        set targetWindow to missing value
        repeat with i from (count of windows) to 1 by -1
            set w to window i
            try
                set windowTitle to name of w as text
                if windowTitle is workspaceFolderName then
                    set targetWindow to w
                    exit repeat
                end if
            end try
        end repeat
        if targetWindow is missing value then
            repeat with i from (count of windows) to 1 by -1
                set w to window i
                try
                    set windowTitle to name of w as text
                    if windowTitle contains workspaceFolderName then
                        if windowTitle is not traeAppTitle and windowTitle is not "Trae CN" and windowTitle is not "TRAE CN" and windowTitle is not "Trae" and windowTitle is not "TRAE SOLO CN" and windowTitle is not "TRAE SOLO" then
                            set targetWindow to w
                            exit repeat
                        end if
                    end if
                end try
            end repeat
        end if`;
};

export type TraeOpenBaseline = {
  titles: string[];
  windowCount: number;
};

export const getTraeWindowCount = async (): Promise<number> => {
  const processList = TRAE_PROCESS_NAMES.map((name) => `"${name}"`).join(', ');
  const script = `tell application "System Events"
    repeat with candidateName in {${processList}}
        if exists process (candidateName as text) then
            return count of windows of process (candidateName as text)
        end if
    end repeat
    return 0
end tell`;
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
};

export const getTraeWindowTitles = async (): Promise<string[]> => {
  const processList = TRAE_PROCESS_NAMES.map((name) => `"${name}"`).join(', ');
  const script = `tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {${processList}}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then return ""
    set titleList to {}
    tell process traeProcessName
        repeat with w in windows
            try
                set end of titleList to name of w as text
            end try
        end repeat
    end tell
    set AppleScript's text item delimiters to linefeed
    return titleList as text
end tell`;
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script]);
    const raw = stdout.trim();
    return raw ? raw.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
};

export const captureTraeOpenBaseline = async (): Promise<TraeOpenBaseline> => ({
  titles: await getTraeWindowTitles(),
  windowCount: await getTraeWindowCount(),
});

export const buildTraeWindowProbeScript = (
  applicationName = 'Trae CN',
  workspacePath = '',
  baseline: TraeOpenBaseline | null = null,
) => {
  const processList = TRAE_PROCESS_NAMES.map((name) => `"${name}"`).join(', ');
  const folderName = workspaceFolderName(workspacePath);
  const baselineList = baseline && baseline.titles.length > 0
    ? baseline.titles.map((title) => `"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')
    : '""';
  const baselineGate = baseline
    ? `if (count of windows) > ${baseline.windowCount} then return "ready"
        set baselineTitles to {${baselineList}}
        repeat with oldTitle in baselineTitles
            if oldTitle is not "" and windowTitle is oldTitle then return "waiting"
        end repeat`
    : '';
  const matchBlock = buildTraeWindowMatchBlock(folderName, applicationName);
  return `tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {${processList}}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then return "waiting"
    tell process traeProcessName
        if (count of windows) is 0 then return "waiting"
        ${matchBlock}
        if targetWindow is missing value then return "waiting"
        set windowTitle to name of targetWindow as text
        ${baselineGate}
        return "ready"
    end tell
end tell`;
};

export type TraeAtomicSubmitOptions = {
  openWorkspace?: boolean;
  reuseExisting?: boolean;
  traeCli?: string | null;
  appBundle?: string | null;
};

const buildTraeWorkspacePathVars = (workspacePath: string) => {
  const escapedWorkspace = workspacePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `set workspacePath to "${escapedWorkspace}"`;
};

const buildTraeOpenAtStartBlock = (
  workspacePath: string,
  applicationName: string,
  openWorkspace: boolean,
) => {
  if (!openWorkspace) return '';
  return `${buildTraeWorkspacePathVars(workspacePath)}
set traeAppName to "${applicationName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
tell application traeAppName
    activate
    open POSIX file workspacePath
end tell
delay 3.0
`;
};

export const buildTraeAtomicSubmitScript = (
  prompt: string,
  applicationName = 'Trae CN',
  workspacePath = '',
  baseline: TraeOpenBaseline = { titles: [], windowCount: 0 },
  options: TraeAtomicSubmitOptions = {},
) => {
  const processList = TRAE_PROCESS_NAMES.map((name) => `"${name}"`).join(', ');
  const folderName = workspaceFolderName(workspacePath);
  const needlesError = workspacePath ? workspaceWindowNeedles(workspacePath).join(', ') : '';
  const matchBlock = buildTraeWindowMatchBlock(folderName, applicationName);
  const baselineList = baseline.titles.length > 0
    ? baseline.titles.map((title) => `"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')
    : '""';
  const openWorkspace = options.openWorkspace ?? false;
  const reuseExisting = options.reuseExisting ?? !openWorkspace;
  const workspacePathVars = buildTraeWorkspacePathVars(workspacePath);
  const openAtStart = buildTraeOpenAtStartBlock(workspacePath, applicationName, openWorkspace);

  return `${openAtStart}set devfleetPrompt to ${appleScriptString(prompt)}
set oldClipboard to ""
try
    set oldClipboard to the clipboard
end try
set the clipboard to devfleetPrompt

tell application "System Events"
    set traeProcessName to ""
    repeat 40 times
        repeat with candidateName in {${processList}}
            if exists process (candidateName as text) then
                set traeProcessName to candidateName as text
                exit repeat
            end if
        end repeat
        if traeProcessName is not "" then exit repeat
        delay 0.5
    end repeat
    if traeProcessName is "" then error "Trae process not found after wait"

    tell process traeProcessName
        ${workspacePathVars}
        set needOpenWorkspace to ${openWorkspace ? 'true' : 'false'}
        set reuseExistingWindow to ${reuseExisting ? 'true' : 'false'}
        set baselineWindowCount to ${baseline.windowCount}
        set baselineTitles to {${baselineList}}
        set targetWindow to missing value

        repeat with matchAttempt from 1 to 180
            set targetWindow to missing value
            if (count of windows) is 0 then
                delay 0.5
            else
                ${matchBlock}
                if targetWindow is not missing value then
                    set windowTitle to name of targetWindow as text
                    if windowTitle is "Trae CN" or windowTitle is "TRAE CN" or windowTitle is "Trae" then
                        set targetWindow to missing value
                    else if windowTitle is workspaceFolderName or windowTitle contains workspaceFolderName then
                        if reuseExistingWindow then
                            exit repeat
                        else if (count of windows) > baselineWindowCount then
                            exit repeat
                        else
                            set seenBefore to false
                            repeat with oldTitle in baselineTitles
                                if oldTitle is not "" and windowTitle is oldTitle then
                                    set seenBefore to true
                                    exit repeat
                                end if
                            end repeat
                            if seenBefore is false then exit repeat
                            set targetWindow to missing value
                        end if
                    end if
                end if
            end if
            delay 0.5
        end repeat

        if targetWindow is missing value then error "Trae workspace window not found (${needlesError})"
        set frontmost to true
        click targetWindow
        delay 0.8
        click targetWindow
        delay 1.0

        set dismissedTrust to false
        repeat with trustAttempt from 1 to 8
            repeat with e in entire contents of targetWindow
                try
                    set elementName to name of e
                    set elementRole to role of e
                    if elementRole is "AXButton" or elementRole is "button" then
                        if elementName contains "我信任" or elementName contains "I trust" or elementName contains "trust the author" then
                            click e
                            set dismissedTrust to true
                            delay 1.5
                            exit repeat
                        end if
                    end if
                    if elementRole is "AXCheckBox" or elementRole is "checkbox" then
                        if elementName contains "agent-workspace" or elementName contains "父文件夹" or elementName contains "parent folder" then
                            click e
                        end if
                    end if
                end try
            end repeat
            if dismissedTrust then exit repeat
            delay 0.8
        end repeat

        set triggeredNewTask to false
        repeat with e in entire contents of targetWindow
            try
                set elementName to name of e
                set elementRole to role of e
                if elementRole is "AXButton" or elementRole is "button" then
                    if elementName contains "新任务" or elementName contains "New Task" or elementName contains "新建任务" or elementName contains "Create Task" then
                        click e
                        set triggeredNewTask to true
                        exit repeat
                    end if
                end if
            end try
        end repeat

        if triggeredNewTask is false then
            try
                click targetWindow
                delay 0.3
                keystroke "n" using {control down, command down}
                delay 1.2
                set triggeredNewTask to true
            end try
        end if

        if triggeredNewTask is false then error "Failed to trigger Trae New Task"

        delay 1.2
        repeat with e in entire contents of targetWindow
            try
                set elementRole to role of e
                if elementRole is "AXTextArea" or elementRole is "AXTextField" or elementRole is "text area" or elementRole is "text field" then
                    set focused of e to true
                    exit repeat
                end if
            end try
        end repeat

        keystroke "v" using command down
        delay 0.5
        key code 36
    end tell
end tell

delay 0.2
try
    set the clipboard to oldClipboard
end try`;
};

export const buildTraeNewTaskScript = (
  prompt: string,
  applicationName = 'Trae CN',
  workspacePath = '',
  options: TraeAtomicSubmitOptions = {},
) => buildTraeAtomicSubmitScript(prompt, applicationName, workspacePath, { titles: [], windowCount: 0 }, options);

const TRAE_WORKSPACE_SETTINGS = '{\n  "security.workspace.trust.enabled": false\n}\n';

export const prepareTraeWorkspaceSettings = (workspacePath: string) => {
  const vscodeDir = join(workspacePath, '.vscode');
  mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(join(vscodeDir, 'settings.json'), TRAE_WORKSPACE_SETTINGS, 'utf8');
};

export const isTraeWorkspaceWindowOpen = async (
  workspacePath: string,
  applicationName: string,
): Promise<boolean> => {
  const probe = buildTraeWindowProbeScript(applicationName, workspacePath, null);
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', probe]);
    return stdout.trim() === 'ready';
  } catch {
    return false;
  }
};

export const focusTraeWorkspace = async (workspacePath: string, applicationName: string) => {
  const processList = TRAE_PROCESS_NAMES.map((name) => `"${name}"`).join(', ');
  const folderName = workspaceFolderName(workspacePath);
  const matchBlock = buildTraeWindowMatchBlock(folderName, applicationName);
  const script = `tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {${processList}}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then error "Trae process not found"
    tell process traeProcessName
        set frontmost to true
        ${matchBlock}
        if targetWindow is missing value then error "Trae workspace window not found"
        click targetWindow
        delay 0.5
        click targetWindow
    end tell
end tell`;
  await execFileAsync('/usr/bin/osascript', ['-e', script]);
};

export const openTraeWorkspace = async (workspacePath: string) => {
  if (!existsSync(workspacePath)) {
    throw new Error(`工作区不存在: ${workspacePath}`);
  }
  if (process.platform !== 'darwin') {
    throw new Error('openTraeWorkspace 目前仅支持 macOS');
  }
  const app = findTraeAppBundle();
  if (!app) throw new Error('未找到 Trae / Trae CN 应用');
  prepareTraeWorkspaceSettings(workspacePath);
  const applicationName = traeApplicationNameFromBundle(app);
  const script = `tell application "${applicationName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
    activate
    open POSIX file "${workspacePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell`;
  await execFileAsync('/usr/bin/osascript', ['-e', script]);
};

export const submitTraeNewTask = async (workspacePath: string, prompt: string, skipWait = false) => {
  if (!existsSync(workspacePath)) {
    throw new Error(`工作区不存在: ${workspacePath}`);
  }
  if (process.platform === 'darwin') {
    const app = findTraeAppBundle();
    if (!app) throw new Error('未找到 Trae / Trae CN 应用');
    prepareTraeWorkspaceSettings(workspacePath);
    const applicationName = traeApplicationNameFromBundle(app);
    if (!skipWait) {
      await focusTraeWorkspace(workspacePath, applicationName);
    }
    try {
      await execFileAsync('/usr/bin/osascript', [
        '-e',
        buildTraeAtomicSubmitScript(prompt, applicationName, workspacePath, { titles: [], windowCount: 0 }, {
          openWorkspace: false,
          reuseExisting: true,
        }),
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('-25211') || detail.includes('辅助访问') || /assistive/i.test(detail)) {
        throw new Error(
          `${detail}。请在「系统设置 → 隐私与安全性 → 辅助功能」中勾选 Cursor（或运行 MCP 的终端应用）与 Trae，然后重试。`,
        );
      }
      throw error;
    }
    return;
  }
  if (process.platform === 'win32') {
    await startTraeTaskWindows(workspacePath, prompt);
    return;
  }
  throw new Error('submitTraeNewTask 目前仅支持 macOS 与 Windows Trae');
};

const startTraeTaskMacos = async (workspacePath: string, prompt: string) => {
  const baseline = await captureTraeOpenBaseline();
  const app = findTraeAppBundle();
  if (!app) throw new Error('未找到 Trae / Trae CN 应用');
  const applicationName = traeApplicationNameFromBundle(app);
  const cli = resolveTraeCli(app);
  prepareTraeWorkspaceSettings(workspacePath);
  const alreadyOpen = await isTraeWorkspaceWindowOpen(workspacePath, applicationName);
  if (alreadyOpen) {
    await focusTraeWorkspace(workspacePath, applicationName);
  }
  await execFileAsync('/usr/bin/osascript', [
    '-e',
    buildTraeAtomicSubmitScript(prompt, applicationName, workspacePath, baseline, {
      openWorkspace: !alreadyOpen,
      reuseExisting: alreadyOpen,
      traeCli: cli,
      appBundle: app,
    }),
  ]);
};

const startTraeTaskWindows = async (workspacePath: string, prompt: string) => {
  const script = resolveComputerUseScript();
  const promptPath = join(tmpdir(), `devfleet-trae-prompt-${process.pid}.txt`);
  writeFileSync(promptPath, prompt, 'utf8');
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-WorkspacePath',
      workspacePath,
      '-PromptPath',
      promptPath,
    ], { maxBuffer: 10 * 1024 * 1024 });
  } finally {
    try {
      unlinkSync(promptPath);
    } catch {
      // Best effort cleanup.
    }
  }
};

export const startTraeTaskWithComputerUse = async (workspacePath: string, prompt: string) => {
  if (!existsSync(workspacePath)) {
    throw new Error(`工作区不存在: ${workspacePath}`);
  }

  if (process.platform === 'darwin') {
    await startTraeTaskMacos(workspacePath, prompt);
    return;
  }

  if (process.platform === 'win32') {
    await startTraeTaskWindows(workspacePath, prompt);
    return;
  }

  throw new Error('devfleet_computer_use_start_trae_task 目前仅支持 macOS 与 Windows Trae');
};
