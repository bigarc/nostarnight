# Matrees World Library · Obsidian 插件

版本：**1.0.0**

Matrees World Library 用于在 Obsidian 中浏览并同步 Matrees 世界观资料。插件将云端结构转换为本地 Markdown。

## 安装

1. 关闭 Obsidian
2. 将分发包中的 `matrees-world-library` 文件夹放入仓库的 `.obsidian/plugins/`
3. 确认目录中至少包含 `main.js`、`manifest.json`、`styles.css`
4. 启动 Obsidian，在“第三方插件”中启用 **Matrees World Library**。
5. 在插件设置中填写自己的 Matrees Token，并执行连接验证

升级已有安装时，仅覆盖程序文件并保留原有 `data.json`，以继续使用本地 Token、同步索引和冲突保护基线

## Token获取

- 进入你的 matrees 页面，按下 F12 ，进入 应用程序 ，左侧打开本地存储， 点击下拉的链接，查看右方出现的 Token 字段，复制这个。(再次提醒 注意隐私！！！)

> 分发包本身不包含 `data.json`、Token、账号标识、个人路径或调试数据。

## 主要功能

- 世界观卡片浏览、搜索与同步。
- 同步过程中边拉取边写入 Obsidian 左侧文件目录。
- 增量更新：未变化内容不重复写入，本地修改区保持不变。
- 设定与设定集按真实名称生成路径。
- Tiptap / HTML / 结构化内容转换为 Obsidian Markdown。
- 保留标题、粗体、斜体、删除线、下划线、颜色、高亮、居中/右对齐、列表、任务、表格、代码、公式和媒体等可转换格式
- Matrees 站内引用转换为 Obsidian `[[双链|真实名称]]`，可解析的实体 ID 显示为真实名称。
- 世界概念、插画、事件、地图、作品和小说章节等资料按对应目录同步
- 图片与视频封面支持文件 ID → 媒体 URL 解析，并通过 Obsidian 网络层读取
- Token 持久化到插件本地配置，支持的 Obsidian 版本同时使用 SecretStorage 作为恢复副本
- 同步错误、媒体错误和正文缺失问题集中记录，并对 Token 等凭证做脱敏处理
- 本地修改可预览并作为 Matrees 提案提交，交前会再次核对云端状态

## 本地目录与数据安全

默认根目录为 `Matrees/`，每个世界的同步页面包含“云端区域”和“本地修改区域”：同步只更新受控的云端区域，检测到未知文件、手工修改云端区或同步期间文件变化时，插件不会直接覆盖，保留原文件或生成冲突候选。

为了保证可恢复性，`_原始数据/` 中会保存 Matrees 返回的原始结构快照。这里可能包含世界资料本身的服务端 ID。

## Token 与隐私

- Token 仅由用户在自己的 Obsidian 中配置
- 分发包不预置任何 Token、账号 ID、用户目录、测试凭证或调试数据。
- 插件错误文本会隐藏常见 Token / Authorization 字段
- Token 属于敏感信息；不要分享自己的插件 `data.json`
- 媒体域请求不会附带 Matrees 登录 Token

## 网络与权限

插件只使用用户当前 Token 能访问的 Matrees 接口。真正的数据访问权限由 Matrees 服务端决定，客户端不会尝试绕过 HTTP 401/403/429 或扩大账户权限。

管理员入口仅提供独立 Token 配置和对应的服务端可访问列表。

## 兼容性

- 最低 Obsidian：1.6.0
- 桌面端：支持 Obsidian 原生请求和桌面 HTTPS 兼容通道。
- 移动端：使用 Obsidian 提供的 Vault / requestUrl API。

## 分发包结构

正式分发包只包含运行和合规所需文件：

```text
matrees-world-library/
├── main.js
├── manifest.json
├── styles.css
├── README.md
├── THIRD-PARTY-NOTICES.md
└── third-party-licenses/
```

不包含源码备份、测试、调试说明、`.notebook`、构建缓存、`node_modules` 或 `data.json`。
