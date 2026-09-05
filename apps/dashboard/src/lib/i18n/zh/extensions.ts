import type { TranslationKey } from "../en";

export const zh_extensions: Partial<Record<TranslationKey, string>> = {
  "extensions.kind.deploy": "部署",
  "extensions.kind.host": "主机",
  "extensions.source.builtIn": "内置",
  "extensions.capabilities": "读取",
  "extensions.actions": "操作",
  "extensions.hosts": "可访问",
  "extensions.where.servers": "它的机器也会显示在服务器列表中，与不属于任何扩展的机器并列。",
  "extensions.open": "打开 {name}",
  "extensions.page.hostWhere": "{name} 的机器显示在服务器列表中，与不属于任何扩展的机器并列 —— 这样它们仍是一份列表，而不会按服务商拆开。本页面用于管理扩展本身。",
  "extensions.page.openServers": "打开服务器列表",
  "extensions.page.unknown": "未安装名为「{id}」的扩展。",
  "extensions.builtInOnly": "这里的扩展都随 NoMoreIDE 一起发布，因此暂时无法安装或移除。标有 * 的操作会改变生产环境，执行前会先确认。「可访问」是强制生效的，不只是说明：访问其他主机的请求在发出之前就会被拒绝。",
  "extensions.error": "无法加载扩展：{error}",
  "extensions.section.downloaded": "已下载（{count}）",
  "extensions.section.market": "市场",
  "extensions.market.title": "暂时没有可浏览的内容",
  "extensions.market.body":
    "所有扩展都随 NoMoreIDE 一起发布，因此没有可下载的内容。等到插件可以在运行时加载，这里才会开放浏览 —— 届时它们将来自现在已经在分发智能体配置的同一个注册表。",
};
