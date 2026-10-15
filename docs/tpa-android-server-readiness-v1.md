# Android 远程中继部署记录

日期：2026-10-15。状态：独立中继已部署，真实公网加密消息转发通过；尚未完成真实手机和 Pi 会话验收。

## 部署范围

用户已授权复用现有服务器。新服务与已有 Workbench、记忆、待办、微信和数据库分离，不持有模型密钥，不保存聊天明文。

| 项目 | 当前值 |
| --- | --- |
| 公网路径 | `wss://workbench.starveiled.cn/tpa-relay/v1` |
| 健康检查 | `https://workbench.starveiled.cn/tpa-relay/v1/health` |
| 服务账号 / 服务 | `tpa-relay` / `tpa-relay.service` |
| 固定制品 | `/opt/tpa-relay/releases/0.1.0-73c8e17251e8`；current 软链接 |
| 配置 | `/etc/tpa-relay/config.json`；仅服务可读，保存路由凭据摘要 |
| 状态 | `/var/lib/tpa-relay/routes.json`；只保存轮换后的手机路由摘要 |
| 监听 | `172.18.0.1:4791`；没有开放公网直连端口 |
| 防火墙 | 仅 Caddy 所在 `br-20fda627b199` 网桥、`172.18.0.0/16` 到网关 4791/TCP |
| 资源约束 | MemoryMax 192 MB、CPUQuota 50%、无登录账号、只读系统、状态目录定点写入 |
| 回退 | `/opt/tpa-relay/rollback.py`，保留配置和数据，不删除既有服务 |

本机制品与 SHA-256 清单位于 `E:/A PI/output/TPA/relay-0.1.0/`。服务器只接收固定制品，没有手改服务器上的运行源码。密钥和原始 token 仅保存在本机用户专属私有目录，未进入仓库、日志或交付包。

## 代理变更

仅在原 Workbench 站点增加 `/tpa-relay/v1/*` 路径，其余请求仍发往原 4790 服务。Caddy 配置先 validate 再 reload，没有重启既有云端服务或数据库。

运行日志编码器删除 WebSocket 凭据所在的协议请求头，防止上游异常日志带出凭据。这一配置依据 [Caddy 全局日志](https://caddyserver.com/docs/caddyfile/options) 与 [字段删除过滤器](https://caddyserver.com/docs/caddyfile/directives/log)。代理配置原文保存在 `/opt/tpa-relay/Caddyfile.before`。

回退脚本先比较部署后配置摘要；如果后来有人修改 Caddy，脚本停止并保留当前配置，要求人工合并。摘要匹配时恢复原路由、重载 Caddy、停止新中继并删除本次精确防火墙规则，不动 Workbench 数据。

## 已验证

- 中继服务 active，实测空闲内存约 12 MB；资源读数不是容量压测。
- HTTPS 健康、未知凭据拒绝、两个已认证 WSS 连接之间的密文往返通过。
- Workbench HTTP 健康仍为 `ok: true`，已有服务 active。
- 回执与配对撤销已通过本地真实连接测试；公网检查只发送合成密文。

证据位于 `E:/A PI/output/TPA/relay-public-verification.json`。真实模型调用、真实 TPA 指令和真实手机验收均为 0 次。

## 继续验收

小米安装测试 APK 后，在配套桌面“设置 → 外部连接 → Android 随身助理”生成邀请。手机扫码后，电脑还需确认该手机。测试移动网络、切后台恢复、切换网络、旧确认失效和撤销访问。

不预先要求关闭小米所有省电设置；先记录实际限制。首版无后台推送保证。电脑关机时不运行电脑任务。
