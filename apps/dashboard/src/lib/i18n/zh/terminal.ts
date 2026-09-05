import type { TranslationKey } from "../en";

export const zh_terminal: Partial<Record<TranslationKey, string>> = {
  // Terminal
  "terminal.tabs": "终端标签页",
  "terminal.tabName": "终端 {n}",
  "terminal.closeTab": "关闭 {name}",
  "terminal.newTerminal": "新建终端",
  "terminal.starting": "正在启动终端…",
  "terminal.localWorkspace": "本地工作区",
  "terminal.openingShell": "正在打开 shell",
  "terminal.shellConnected": "Shell 已连接",
  "terminal.socketClosed": "Socket 已关闭",
  "terminal.socketError": "终端 socket 错误",
  "terminal.repairTitle": "终端辅助程序不可执行",
  "terminal.repairBody": "NoMoreIDE 可以恢复 node-pty 辅助程序权限并重试此会话。",
  "terminal.repairAction": "修复并重试",
  "terminal.repairing": "修复中…",
  "terminal.restart": "重启终端",
  "terminal.stop": "停止终端",
  "terminal.viewport": "终端视口",
  "terminal.confirmRestartTitle": "重启终端？",
  "terminal.confirmStopTitle": "停止终端？",
  "terminal.confirmRestartBody": "正在运行的 shell 进程将被终止，并启动一个新的 shell。",
  "terminal.confirmStopBody": "正在运行的 shell 进程将被终止。",
};
