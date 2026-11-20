# 开发站独立发布

开发分支为 `dev`，网站为 `https://dev-yixu.8882088.xyz/`，后台位于同源 `/admin/`，接口仍为 `/api/admin/` 并保持独立登录、CSRF 和 HttpOnly Cookie。正式网站、旧后台域名、生产服务和生产私有数据不参与此流程。

## 隔离边界

| 用途 | 开发环境 |
| --- | --- |
| 服务用户 | `yixu-dev` |
| 代码与构建 | `/srv/yixu-wardrobe-dev/releases/<完整提交SHA>` |
| 当前版本 | `/srv/yixu-wardrobe-dev/current` 原子符号链接 |
| API | `yixu-dev-api.service`，仅 `127.0.0.1:8766` |
| 独立生成 worker | 显式启用生成时使用 `yixu-dev-worker.service` |
| 私有数据 | `/var/lib/yixu-wardrobe-dev`，0700 |
| 服务配置 | `/etc/yixu-wardrobe-dev/runtime.env`，0600 |
| 部署配置 | `/etc/yixu-wardrobe-dev/deploy.json`，0600 |
| 安装后的发布控制器 | `/usr/local/libexec/yixu-dev-release.py`，root 所有 |
| 发布回执与日志 | `/var/lib/yixu-dev-deploy`，root 所有、0700 |
| Node | `/opt/yixu-dev-node`，不改系统 Node |
| 定时检查 | `yixu-dev-deploy.timer` / `yixu-dev-deploy.service` |

开发环境使用独立 SQLite、管理员密码、会话、资源归档和结果目录，不复制生产照片、数据库或账号。AI 生成默认关闭；用户明确授权复用正式站模型配置后，才可在服务器内部将模型连接/参数配置独立复制到开发私有 `runtime.json`，保留 0600 与开发用户所有，不输出项目 Key。私有 `deploy.json` 的严格布尔字段 `generation_enabled` 默认 false，授权启用时设 true，并独立安装、启用 `dev-worker.service`。首次 API 启动自动创建开发管理员，初始凭据仅保存在开发私有数据目录的 `initial-admin.json`，不得打印到发布日志或提交 Git。

离线地域库可独立安装到开发数据目录的 `geoip/city.mmdb`；仅复制公开可下载的库，不复制生产访客记录。数据库不进入仓库或静态网站。

## 首次准备

本目录提供 `dev-api.service`、`dev-worker.service`、`dev-deploy.service`、`dev-deploy.timer` 和 `dev-site.conf`。服务安装者须创建上述独立用户与目录、设置所有权，并将发布控制器复制到 root 所有的固定路径；仓库中的控制器更新不会自动替换已安装副本，基础设施改动需要单独审阅安装。

开发环境变量：

```ini
YIXU_DATA_DIR=/var/lib/yixu-wardrobe-dev
YIXU_PUBLIC_HOST=dev-yixu.8882088.xyz
YIXU_ADMIN_HOST=dev-yixu.8882088.xyz
YIXU_SECURE_COOKIES=true
YIXU_CONTENT_ROOT=/srv/yixu-wardrobe-dev/current/content
YIXU_IMAGE_ROOT=/srv/yixu-wardrobe-dev/current/public
YIXU_GEOIP_DATABASE=/var/lib/yixu-wardrobe-dev/geoip/city.mmdb
```

服务器下载进程如需既有 loopback 传输，可在私有 `deploy.json` 中显式设置 `download_proxy` 为 `http://127.0.0.1:端口`。控制器只接受无账户、无路径和无查询参数的 loopback HTTP 地址；设置仅传给 Git、uv 与发布核验请求，不传给 API，不改变全局 DNS、路由、生产服务或现有代理配置。未配置时使用普通 HTTPS；不自动切换网络出口。

本次准备使用官方 Node 22.23.5 Linux x64 二进制，下载文件 SHA-256 为 `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`，取自对应版本的 [Node 官方校验清单](https://nodejs.org/dist/v22.23.5/SHASUMS256.txt)。安装前核对官方清单及实际文件，不将二进制提交仓库。更新工具版本仍需单独验证。

域名 A 记录生效后，仅为开发域名使用现有 `/var/lib/letsencrypt` webroot 签发独立证书。`dev-site.conf` 不替换正式虚拟主机或证书。证书尚未准备时，可从同一模板生成独立 HTTP 开发虚拟主机，按 Host 头验证；此时只报告 HTTP 预备完成，不能称 HTTPS 开发站已上线。

## 自动发布与验收

普通 GitHub CI 仍只验证和构建，不保存服务器 SSH 密钥、不直接登录服务器。开发服务器的定时器在一次运行结束约一分钟后检查 `origin/dev`：

1. 以 `yixu-dev` 拉取公开仓库的 `refs/heads/dev`，取得完整 SHA。
2. 查询该 SHA、`dev` 分支、push 事件对应的现有 `check.yml` **整个工作流**结论，只有最新一轮 completed/success 才继续。未完成、失败或查询失败不切换站点。
3. 在独立候选目录导出该提交，以 `yixu-dev` 运行锁定依赖安装、图片与内容检查、原有交互回归、静态构建及全部后端 pytest。仓库命令不以 root 运行，不读取生产环境变量。首次下载依赖可能较慢，原站继续服务。
4. 成功后先停止固定的开发 worker 认领新任务，等待在途任务正常结束，再原子切换开发 `current`。只重启固定的 `yixu-dev-api.service`，显式授权生成时再启动固定的 `yixu-dev-worker.service`，两者使用同一代码与私有状态。worker 的 SIGTERM 会等待当前请求完成，停止宽限覆盖最长配置请求；异常中止仍遵循“可能发送后不自动重放”的既有恢复规则。
5. 核对开发 API 健康；默认模式要求生成关闭，显式生成模式要求 provider、detector 与 `generation_available` 均为 true、开发 worker active（不发实际生成测试）。再核对管理员接口未登录返回 401、API/静态内容版本和首页主推一致、十四个核心网站/后台文件实际字节，以及首页主推源图字节数和 SHA-256。通过后才写 root 私有的 `deployment.json`，并按后端合同写入开发数据目录的 `publication.json`（0600，开发服务用户所有）；后台据此显示网站已验证。

互斥锁阻止重叠发布。已验证的相同 SHA 不重复构建；失败 SHA 只尝试一次，等待人工检查，不循环重启。候选构建失败不切换站点；切换后核验失败会先停止新开发 worker，再恢复上一个开发版本并重启开发 API及已授权的开发 worker。开发私有数据库不会回滚，生产服务不会重启。首次发布失败且没有旧开发版本时停止开发 worker与 API并保留失败回执。

确认开发 HTTPS 已准备好、首次完整发布已验收后再启用：

```sh
systemctl enable --now yixu-dev-deploy.timer
systemctl status yixu-dev-deploy.timer yixu-dev-api.service
```

开发完成后提交并推送 `dev`；CI 成功后定时器自动处理。发布日志和回执分别在 `build.log`、`deployment.json`，只留服务器私有目录。回执是检查时点的结果，不是持续可用性证明。

手动检查或已审阅重试：

```sh
systemctl stop yixu-dev-deploy.timer
python3 /usr/local/libexec/yixu-dev-release.py
```

失败候选目录会保留供调查。确认原因并完成修复后，可显式加 `--retry`：逐文件核对候选与目标 Git blob、修复仅 Web 根目录权限、重跑内容/交互/后端测试并核对快照版本后复用候选，不重建或删除当前版本、候选或私有数据库。源码有任何字节变化则拒绝复用；应提交修复形成新 SHA。不得删除当前或所需回滚版本。历史开发版本不自动删除，应按服务器容量人工整理。

首次 HTTP 验收可用 `--origin http://127.0.0.1`，控制器仍发送开发域名 Host。自动定时器通过真实 HTTPS 域名与严格 CA/SNI 验证核对本站（用 `curl --resolve` 连接本机 Nginx，避免公网回环依赖）；公网正常 DNS/HTTPS 另行实测，不以关闭 TLS 校验替代证书或 DNS 配置。源码提交、CI、HTTP 预备、HTTPS发布和自动定时器状态应分别报告。

## 回归

```sh
node qa/regression-dev-deploy.mjs
```

回归覆盖 CI 门禁、固定服务/目录隔离、同源后台、管理员鉴权及核心文件核验、切换失败恢复、数据库不回滚、同一失败 SHA 不循环尝试。真实服务器还必须执行 `nginx -t`、实际 HTTP/HTTPS与 API/后台检查，并核对正式虚拟主机、服务 PID/启动时间、当前版本与配置哈希保持原样。
