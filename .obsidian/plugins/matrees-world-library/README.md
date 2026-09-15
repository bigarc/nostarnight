# Matrees World Library 1.1.0

面向 Obsidian 的 Matrees 世界观只读同步插件。此版本重写了设定抓取核心，不再依赖旧版运行时补丁。

## 本版重点

- 单条设定失败不会中断整个世界观：失败项记录后继续处理后续条目。
- 设定详情统一经过规范化层，兼容 `definition/detail/item/entity/data/result/info` 等常见包装结构，以及 `content/body/document/doc/editorData/richText/contentJson/text` 等正文位置。
- 保留详情身份校验；如果接口返回了别的设定或别的世界，只跳过该条正文，不会把错误内容写入其他文件。
- GET 请求遇到网络错误、HTTP 429 或 5xx 会有限次退避重试。
- 列表分页支持 `page/size`、`pageNum/pageSize`、`current/size` 三种模式；某一种分页停滞时会尝试下一种。仍无法完整分页时保留已成功取得的条目并继续同步。
- 媒体优先使用 `fileId -> /mt/file/get/oss/url/{fileId}` 换取新的 OSS 地址后再离线保存，以减少旧签名 URL 造成的 403。
- 继续采用边拉取边写入、增量更新、旧文件名迁移、Token 持久化、Matrees 内链转 Obsidian 双链等功能。

## 失败隔离原则

以下错误默认只影响单个条目，不再终止整个世界：单条详情 404/403、详情身份不匹配、正文缺失、单张媒体失败、单个扩展资料失败。

仍会终止同步的情况包括：Token 整体失效、连接被用户切换/关闭、世界观本身无权访问、Vault 基础写入无法继续等。

## 安装

将本目录放入：

`.obsidian/plugins/matrees-world-library/`

至少保留：`main.js`、`manifest.json`、`styles.css`。

分发包不包含 `data.json`、Token、账号 ID、测试数据或本机路径。升级时不要删除你已有的 `data.json`。
