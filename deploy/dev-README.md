# 开发站独立发布

开发分支为 `dev`，网站为 `https://dev-yixu.8882088.xyz/`，后台位于同源 `/admin/`，接口仍为 `/api/admin/` 并保持独立登录、CSRF 和 HttpOnly Cookie。正式网站、旧后台域名、生产服务和生产私有数据不参与此流程。

## 网络与运行位置

当前应用服务器运行开发站源站、API、worker 和自动发布。cn001 接收开发域名的 HTTPS 请求，使用原有证书与 ACME webroot，再把请求交给本机的 FRP 转发端口。

```text
dev-yixu.8882088.xyz → cn001 Nginx HTTPS → cn001 127.0.0.1:18866 (frps)
    → FRP 隧道 → 应用服务器 frpc → 源站 Nginx Unix socket → 静态文件或开发 API
```

应用服务器的 `frpc` 主动连接 cn001 公网 IP 的 TCP `18868`。在云主机使用 NAT 时，`frps` 绑定公网 IP 对应的本机网卡地址。TCP 转发端口 `18866` 绑定 cn001 回环，`allowPorts` 仅允许该端口。应用服务器的 Nginx 回环端口 `18866` 用于本地验收。隧道使用双向 TLS 和 token，客户端校验服务端证书中登记的公网 IP。cn001 覆写公网请求的转发头，源站仅从受权限保护的 Unix socket 接受转发 IP。

## 隔离边界

| 用途 | 开发环境 |
| --- | --- |
| 服务用户 | `yixu-dev` |
| 代码与构建 | `/srv/yixu-wardrobe-dev/releases/<完整提交SHA>` |
| 当前版本 | `/srv/yixu-wardrobe-dev/current` 原子符号链接 |
| API | `yixu-dev-api.service`，仅 `127.0.0.1:18867` |
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

在应用服务器创建独立的 `yixu-dev` 用户、数据和构建目录，并创建系统组 `yixu-dev-tunnel`。把 `dev-api.service`、`dev-worker.service`、`dev-deploy.service`、`dev-deploy.timer`、`dev-origin.service` 和 `dev-frpc.service` 安装为名称带 `yixu-` 前缀的 systemd 单元。将 `dev-origin-nginx.conf` 和 `dev-site.conf` 分别装到 `/etc/yixu-wardrobe-dev-origin/nginx.conf` 和 `site.conf`。把 `dev-release.py` 安装到上表的 root 所有路径。仓库中的部署文件更新后，需显式安装现场副本。

cn001 安装 `yixu-dev-frps.service`、`yixu-dev-cert-renew.service` 和 `yixu-dev-cert-renew.timer`。确认隧道和源站可用后，将 `dev-edge.conf` 安装为开发域名的 Nginx 虚拟主机，使用 `nginx -t` 验证后 reload。

两端从官方发布包安装同版本 FRP，分别使用对应单元声明的二进制路径。两端 `/etc/yixu-dev-frp/` 为 root 所有，目录 0700、配置和证书文件 0600。服务通过 systemd 凭据读取同一 CA 的公钥、各自的证书和私钥、TOML 配置。两端配置使用同一个随机 token，客户端的 `proxies.plugin` 采用 `unix_domain_socket`，路径为 `/run/yixu-dev-origin/frp.sock`。证书必须包含相应的 `serverAuth` 或 `clientAuth` 用途，服务端证书的 SAN 包含 cn001 的公网 IP。凭据和私钥保存在服务器私有位置。

开发环境变量：

```ini
YIXU_DATA_DIR=/var/lib/yixu-wardrobe-dev
YIXU_PUBLIC_HOST=dev-yixu.8882088.xyz
YIXU_ADMIN_HOST=dev-yixu.8882088.xyz
YIXU_SECURE_COOKIES=true
YIXU_CONTENT_ROOT=/srv/yixu-wardrobe-dev/current/content
YIXU_IMAGE_ROOT=/srv/yixu-wardrobe-dev/current/public
YIXU_GEOIP_DATABASE=/var/lib/yixu-wardrobe-dev/geoip/city.mmdb
YIXU_ADMIN_PASSWORD_MIN_LENGTH=8
```

开发管理员在「账户安全」修改密码时使用此部署的最低长度。服务端允许配置 8–16 个字符，未设置时为 16。仍需输入当前密码，保存后须用新密码重新登录。

服务器下载进程如需既有 loopback 传输，可在私有 `deploy.json` 中显式设置 `download_proxy` 为 `http://127.0.0.1:端口`。控制器只接受无账户、无路径和无查询参数的 loopback HTTP 地址；设置仅传给 Git、uv 与发布核验请求，不传给 API，不改变全局 DNS、路由、生产服务或现有代理配置。未配置时使用普通 HTTPS；不自动切换网络出口。

本次准备使用官方 Node 22.23.5 Linux x64 二进制，下载文件 SHA-256 为 `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`，取自对应版本的 [Node 官方校验清单](https://nodejs.org/dist/v22.23.5/SHASUMS256.txt)。安装前核对官方清单及实际文件，不将二进制提交仓库。更新工具版本仍需单独验证。

域名 A 记录指向 cn001。在 cn001 上为开发域名使用现有 `/var/lib/letsencrypt` webroot 签发独立证书。证书准备期间可先从应用服务器的回环端口验收源站。

## 自动发布与验收

普通 GitHub CI 仍只验证和构建，不保存服务器 SSH 密钥、不直接登录服务器。开发服务器的定时器在一次运行结束约一分钟后检查 `origin/dev`：

1. 以 `yixu-dev` 拉取公开仓库的 `refs/heads/dev`，取得完整 SHA。
2. 查询该 SHA、`dev` 分支、push 事件对应的现有 `check.yml` **整个工作流**结论，只有最新一轮 completed/success 才继续。未完成、失败或查询失败不切换站点。
3. 在独立候选目录导出该提交，以 `yixu-dev` 运行锁定依赖安装、图片与内容检查、原有交互回归、静态构建及全部后端 pytest。仓库命令不以 root 运行，不读取生产环境变量。首次下载依赖可能较慢，原站继续服务。
4. 成功后先停止固定的开发 worker 认领新任务，等待在途任务正常结束，再原子切换开发 `current`。只重启固定的 `yixu-dev-api.service`，显式授权生成时再启动固定的 `yixu-dev-worker.service`，两者使用同一代码与私有状态。worker 的 SIGTERM 会等待当前请求完成，停止宽限覆盖最长配置请求；异常中止仍遵循“可能发送后不自动重放”的既有恢复规则。
5. 核对开发 API 健康；默认模式要求生成关闭，显式生成模式要求 provider、detector 与 `generation_available` 均为 true、开发 worker active（不发实际生成测试）。再核对管理员接口未登录返回 401、API/静态内容版本和首页主推一致、清单中核心网站和后台文件的实际字节，以及首页主推源图字节数和 SHA-256。通过后才写 root 私有的 `deployment.json`，并按后端合同写入开发数据目录的 `publication.json`（0600，开发服务用户所有）；后台据此显示网站已验证。

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

首次 HTTP 验收可用 `--origin http://127.0.0.1:18866`，控制器发送开发域名 Host。自动发布先验收本地源站，再通过公开 HTTPS 域名和标准 CA 校验验收 cn001、FRP 与应用服务器整条链路。源码推送、CI、实际 HTTPS 发布和自动发布状态分别核对。

## 回归

```sh
node qa/regression-dev-deploy.mjs
```

回归覆盖 CI 门禁、固定服务/目录隔离、同源后台、管理员鉴权及核心文件核验、切换失败恢复、数据库不回滚、同一失败 SHA 不循环尝试。真实服务器还必须执行 `nginx -t`、实际 HTTP/HTTPS与 API/后台检查，并核对正式虚拟主机、服务 PID/启动时间、当前版本与配置哈希保持原样。

## 仅开发证书的续期

`dev-cert-renew.service` 与 `dev-cert-renew.timer` 每日两次检查 `dev-yixu.8882088.xyz` 的独立证书，只使用 `certbot renew --cert-name dev-yixu.8882088.xyz`，不改变正式站或原有 `certbot.timer` 的配置。确需现有 loopback 传输时，仅在私有 `/etc/yixu-wardrobe-dev/cert-renew.env` 设置 HTTP(S) 代理，不携带应用密钥。续期成功才执行 Nginx 语法检查与平滑 reload；正常未到续期时间不会重新签发。

在 cn001 安装为 `yixu-dev-cert-renew.service` / `.timer` 后启用后者。私有环境文件须 0600；首次安装验证 unit、启动一次续期检查并检查 timer。开发站证书、自动发布与正式服务状态分别核验。

## 构建资源保护

开发发布 unit 对构建进程及其子进程设置半核 CPU 配额、较低 CPU/IO 权重、物理内存 25% 软阈值及 35% 上限，并限制任务数。达到内存上限时停止开发构建，让该项失败局限在开发发布 unit，减少对正式应用的影响；这些限制不作用于正式服务。限额需要随 unit 安装后才在服务器生效，源码存在不代表现场已经启用。服务器不可访问时暂停发布，先通过控制台检查内存、负载、磁盘和 OOM，再恢复受控发布；不通过未经核实的重启或删除数据恢复。
