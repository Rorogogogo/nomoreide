import type { TranslationKey } from "../en";

export const zh_remote: Partial<Record<TranslationKey, string>> = {
  "remote.title": "在手机上控制这台机器",
  "remote.pageIntro":
    "将这台机器与手机配对，即可随时随地启动或停止服务、查看日志、关注 CI 与智能体用量，并驱动智能体。连接由你的机器主动发起，本机不会监听任何入站连接。",
  "remote.intro": "将这台机器与你的 NoMoreIDE 账号配对，即可在手机上启动或停止服务、查看日志，并观看智能体终端。",
  "remote.pair": "配对这台机器",
  "remote.pairing": "等待批准…",
  "remote.codeLabel": "在手机上输入此代码",
  "remote.openLink": "或打开此链接",
  "remote.pairedAs": "已配对为 {name}",
  "remote.connected": "已连接。手机可以访问这台机器。",
  "remote.notConnected": "已配对，但尚未连接。",
  "remote.unpair": "取消配对",
  "remote.unpairNote": "仅删除本机上的凭据。除非你在手机上撤销，该设备仍会保留在账号中。",
  "remote.expired": "该代码已过期，请重新开始。",
  "remote.failed": "配对未能完成。",
  "remote.safety": "配对后，你的账号可以在这台机器上启动或停止服务、读取日志，并打开终端——包括 shell，它能执行你本人能执行的任何命令。设置 NOMOREIDE_REMOTE_SHELL=0 可仅关闭 shell，其余功能保留。",
  "remote.approve": "在你的账号中批准",
  "remote.approveHint": "将在新标签页中打开 NoMoreIDE。如果你已经登录，这一步就完成了，无需输入代码。",
  "remote.scan": "用手机摄像头扫描此二维码",
  "remote.scanAlt": "指向这台机器配对页面的二维码",
  "remote.orType": "或在手机上输入此代码",

  "remote.openOnPhone": "在手机上打开这台机器",
  "remote.copyLink": "复制链接",
  "remote.openMachine": "在新标签页中打开",
};
