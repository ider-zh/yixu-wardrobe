# 开发站发布

`dev` 分支发布到 `https://dev-yixu.8882088.xyz/`，管理入口为同源 `/admin/`，管理 API 为 `/api/admin/`。开发部署使用独立服务、账号、会话、数据库与私有图片目录。生产环境独立发布。

## 配置位置

| 用途 | 路径或代码 |
| --- | --- |
| 开发账户与版本 | `yixu-dev`，`/srv/yixu-wardrobe-dev/releases/<SHA>`，`current` 为原子切换的符号链接 |
| 私有数据与配置 | `/var/lib/yixu-wardrobe-dev`（0700），`/etc/yixu-wardrobe-dev/{runtime.env,deploy.json}`（0600） |
| 发布控制器与日志 | [dev-release.py](dev-release.py) 安装至 root 所有的 `/usr/local/libexec/yixu-dev-release.py`，日志及回执在 `/var/lib/yixu-dev-deploy`（0700） |
| 监听和定时器 | [API :18867](dev-api.service)、[生成 Worker](dev-worker.service)、[源站 :18866](dev-site.conf)、[发布服务](dev-deploy.service)、[定时器](dev-deploy.timer) |
| 构建工具 | `/opt/yixu-dev-node/bin/node`、`/usr/local/bin/uv`、系统 Python。Node 使用独立安装并核对官方摘要。 |

安装仓库里的单元时统一加 `yixu-` 前缀，例如 `dev-api.service` 安装为 `yixu-dev-api.service`。现场控制器和模板随运维安装更新。发布服务的 CPU、内存、I/O 和任务数限制由 [dev-deploy.service](dev-deploy.service) 定义，构建达到上限时由该单元停止。

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

管理员首次凭据只写入开发私有目录的 `initial-admin.json`。开发试穿默认关闭。经授权启用时，在私有 `deploy.json` 设置布尔值 `generation_enabled: true`，安装独立 Worker，并配置开发私有的 `runtime.json`、YuNet 模型和 `YIXU_FACE_MODEL`。按授权范围配置模型连接；开发库、账号及照片独立使用。公开离线地域库可单独安装到开发环境。私有 `deploy.json` 的可选 `download_proxy` 只接受显式 `http://127.0.0.1:<port>`，用于控制器下载与核验请求。

## 网络与证书

```text
开发域名 → cn001 Nginx HTTPS → cn001 回环 :18866 → FRP 隧道
    → 应用服务器 frpc → /run/yixu-dev-origin/frp.sock → 源站 → 静态文件或 API
```

1. 应用服务器建立 `yixu-dev-tunnel` 组。安装 [dev-origin.service](dev-origin.service) 和 [dev-frpc.service](dev-frpc.service)，将 [dev-origin-nginx.conf](dev-origin-nginx.conf) 与 [dev-site.conf](dev-site.conf) 分别装为 `/etc/yixu-wardrobe-dev-origin/nginx.conf` 和 `site.conf`。源站也在回环 :18866 提供本地验收。
2. cn001 安装 [dev-frps.service](dev-frps.service)。两端使用同版本官方 FRP，按服务单元指定路径安装。FRP 服务端入口为 TCP :18868，转发端口 :18866 限于回环，`allowPorts` 只允许 :18866。NAT 主机绑定公网 IP 对应的本机网卡地址。
3. 两端在 root 私有的 `/etc/yixu-dev-frp/` 保存 TOML、随机 token 和双向 TLS 凭据，通过 systemd 凭据载入。客户端配置使用 `unix_domain_socket` 插件指向上图 socket，并校验服务端证书的公网 IP SAN。cn001 覆写转发头，源站仅从受保护的 Unix socket 接受转发 IP。
4. 域名指向 cn001，使用现有 ACME webroot `/var/lib/letsencrypt` 为开发域名签发独立证书。安装 [dev-edge.conf](dev-edge.conf) 后通过 `nginx -t` 再 reload。安装并启用 [开发证书定时器](dev-cert-renew.timer)，其 [服务](dev-cert-renew.service) 仅续开发域名证书，成功续期才检查 Nginx 并平滑 reload。需要 loopback 传输时使用私有的 `/etc/yixu-wardrobe-dev/cert-renew.env`（0600）。

## 发布和恢复

1. 控制器拉取 `origin/dev`，只接受该 SHA 的 `dev` push 对应 [check.yml](../.github/workflows/check.yml) 的成功结论。CI 负责验证和构建，应用服务器负责实际发布。
2. 控制器在独立候选版本中以 `yixu-dev` 安装锁定依赖、检查内容、运行交互回归、构建静态包及运行后台测试。
3. 验证通过后停止开发 Worker 认领工作并等待在途任务，切换开发 `current`，重启开发 API。在显式启用生成时重启并检查开发 Worker。未确定的外部调用在恢复后不自动重放。
4. 先验收本地源站，再经公开 HTTPS 验收整条链路。检查 API 健康、生成模式、未登录管理 API 返回 401、API 和静态首页版本一致、[核心站点和后台文件](../site-resources.json) 字节一致及主推源图哈希。成功写入 `deployment.json` 和开发私有数据目录中的 `publication.json`。回执记录检查时点。

首次 HTTPS 及完整发布验收后，启用 `yixu-dev-deploy.timer` 并检查它与 API 的服务状态。定时器在上次运行完成约一分钟后再次检查。已验证 SHA 跳过重建。候选构建失败保留当前站点，切换失败恢复上一个开发版本，开发私有数据库继续保留。首次切换失败且无旧版本时停止开发 API 和 Worker。失败 SHA 默认只尝试一次，查看 `/var/lib/yixu-dev-deploy/{build.log,deployment.json}`。

手工重试前暂停定时器并审阅失败原因。为同一 SHA 重试时执行 `/usr/local/libexec/yixu-dev-release.py --retry`，控制器逐一对照 Git blob、重跑验证并核对静态快照后才复用候选。源码修复通过新的 SHA 发布。首次仅验收本地源站时用 `--origin http://127.0.0.1:18866`，此回执只证明本地源站。

## 回归

```sh
node qa/regression-dev-deploy.mjs
```

在目标服务器分别验证 Nginx、systemd、HTTPS、管理鉴权及 `deployment.json`，同时核对正式虚拟主机、正式服务 PID 与配置。源码、CI、公开 HTTPS 和定时器分别报告。
