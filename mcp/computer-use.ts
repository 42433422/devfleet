import { execFile } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

const findTraeAppBundle = (): string | null => {
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
      for (const name of ['Trae CN.app', 'TRAE SOLO CN.app', 'Trae.app', 'TRAE SOLO.app']) {
        const candidate = `/Volumes/${volume}/${name}`;
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // Ignore missing /Volumes on non-standard macOS environments.
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

const buildTraeNewTaskScript = (prompt: string) => `set devfleetPrompt to ${appleScriptString(prompt)}
set oldClipboard to ""
try
    set oldClipboard to the clipboard
end try

tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {"TRAE CN", "Trae CN", "TRAE SOLO CN", "TRAE SOLO", "Trae"}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then error "Trae process not found"

    tell process traeProcessName
        set frontmost to true
        delay 1.2
        key code 45 using {control down, command down}
        delay 0.8
        set the clipboard to devfleetPrompt
        keystroke "v" using command down
        delay 0.4
        key code 36
    end tell
end tell

delay 0.2
try
    set the clipboard to oldClipboard
end try`;

const startTraeTaskMacos = async (workspacePath: string, prompt: string) => {
  const app = findTraeAppBundle();
  if (!app) throw new Error('未找到 Trae / Trae CN 应用');
  await execFileAsync('/usr/bin/open', ['-a', app, workspacePath]);
  await execFileAsync('/usr/bin/osascript', ['-e', buildTraeNewTaskScript(prompt)]);
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
