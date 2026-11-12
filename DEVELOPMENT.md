# 衣序开发说明

仓库：[ider-zh/yixu-wardrobe](https://github.com/ider-zh/yixu-wardrobe)。用户说明见 [README](README.md) / [English](README.en.md)，维护授权见 [AGENTS.md](AGENTS.md)。

## 运行与职责

前端为静态 HTML/CSS/JavaScript，后端复用 Python/FastAPI/SQLite。内容由外部 agent 按[热点穿搭 SOP](docs/external-agent-sop.md)更新项目中的清单及最终 WebP；后台负责访问分析、资源 API、用户穿搭观察、系统模特预览及 CDN 同步观察，不提供另一套穿搭编辑来源。

当前源码已实现动态内容、仅生动展示、项目图片 URL、同步队列和后台观察；尚未选定真实图床，也未因源码开发部署线上站点。[实施计划](docs/content-publishing-plan.md)记录验收范围与后续接入工作。

静态浏览使用 Node.js 22 或更新版本：

```sh
node scripts/check.mjs
node scripts/build.mjs
```

完整复制生成的 `public/` 后直接打开 `public/index.html` 即可离线浏览。根目录 `index.html` + 冻结的 `catalog.js` 仍能浏览初始快照；日更内容的离线快照由构建从清单生成。需要调试源码 HTTP 行为时可运行 `node serve.mjs`，该开发服务器只用于本机，公开部署应仅提供 `public/` 与受控 API。

后端依赖与启动见 [backend/README.md](backend/README.md)。生产经 Nginx 将同源 `/api/` 转发至仅监听 loopback 的单进程 API；管理域沿用独立会话和 Host/CSRF 校验。

## 最新一期与浏览结构

首页、全部穿搭、模特和收藏分别使用 hash 路由，继续支持静态部署与直接打开文件。首页最新一期不受衣橱中的风格、季节、搜索或收藏筛选影响；下方最近更新最多六套，排除首屏套装。完整衣橱默认最新发布，分类是筛选条件，手机端使用筛选弹窗。历史 `#look-编号` 链接继续打开相同套装，关闭详情返回之前的页面及筛选。旧收藏存储键和编号保持不变。

Node 构建和 Python API 都生成 `catalog.home`：`featured_look_id`、`recent_look_ids`、`latest_batch_id`，以及完整的 `latestOrder`。首页和默认列表共用这套顺序，`displayOrder` 保留风格漫游顺序。历史基线没有发布日期时使用 `null`，排在有发布记录的内容之后，不根据图片修改时间推断上新。

前端从构建快照立即呈现内容，API 与快照均有 `revision` 时只接受相同内容版本；不同版本显示同步状态并保留快照，避免旧进程的 100 套目录覆盖新构建的 101 套。同一内容版本仍可更新经过验证的 CDN 地址。完成交付后刷新页面取得相应版本的快照。

构建先在同一文件系统暂存完整输出，再切换专用 `public/`，写入失败时保留旧输出。`node scripts/build.mjs --output 空的候选目录` 只生成候选，不触碰当前网站；显式目标非空时拒绝写入。交付命令和可选的本地提交观察器见 [部署说明](deploy/README.md)。普通 CI 不部署站点。

## 内容源与文件

- `content/catalog.json`：从原目录迁移的生动基线，保留 1—100 编号、分类、单品与镜头；未核对的模特归属为 `null`。总容量不再限制为 100。
- `content/models.json`：系统模特注册。`female-01` 使用 `assets/model-bases/female-01.webp` 五视角基础体；其他模特通过清单更新。
- `content/batches/*.json`：每日一个批次，仅 `v2` 生动。包含实际热点来源、地区、天气依据、模特参考哈希、完整穿搭、九镜头及图片元数据。
- `content/batch.schema.json`：由后端 `Batch` 模型导出的 JSON Schema。修改模型后同步更新该文件；Node 校验和后端导入都必须接受有效交付并拒绝不完整内容。
- `assets/looks/YYYY-MM-DD/*.webp`：外部 agent 的最终公开图片。只提交最终 WebP，不提交生成母本、完整提示词或私人调研记录。
- `catalog.js`、`images/`、`images-v2/`、`image-manifest-all.json`：冻结迁移资料及历史图片完整性基线。公开构建不复制历史 `images/` 或旧 catalog，而是生成仅生动的快照。
- `scripts/content-lib.mjs`：清单读取、引用和 WebP 校验、离线快照资料生成。`scripts/check.mjs` 继续校验 200 张历史图片并校验所有新增清单资源。
- `backend/content.py`：验证候选内容，归档公开 WebP，原子激活版本，提供只读资源接口；坏候选保留上一有效版本。
- `backend/cdn.py` / `cdn_worker.py`：可替换图床接口、持久队列、核对和迁移；API 生命周期运行后台同步，不需要外部 agent 直传。
- `admin/`：既有分析、用户成品与质量观察，以及新增系统模特和内容/CDN 状态。

外部 agent 的内容变更通常只需要新增批次 JSON 与最终 WebP；新增模特时再更新模型注册。新编号不得与基线或其他批次重复。使用新资源修订与新 `asset_id` 修改图片，已发布的资源身份不能替换为其他字节。

本地生成记录、用户数据、凭据和归档目录不进入 Git。`.gitignore` 使用白名单；新资源只开放指定公开目录，不扩大到任意服务器文件。

## 资源接口与本地图片

生产环境显式配置：

- `YIXU_CONTENT_ROOT`：版本化 `content/` 的绝对目录。
- `YIXU_IMAGE_ROOT`：能够解析清单相对图片路径的只读项目资源根目录，不是私有用户数据目录。
- `YIXU_DATA_DIR`：独立于代码发布目录的持久私有数据目录。

未显式传入 `Settings.content_root` 的旧测试/兼容 catalog 可以继续使用原来的受控目录流程；正式动态部署应设置以上路径，避免依赖工作目录推断。

接收新代码与资源后重启应用，构造阶段自动验证并导入候选版本。有效内容复制到 `YIXU_DATA_DIR/public-content/assets/<sha256>.webp`，数据库和活动指针保存在该独立目录内。源文件校验或导入失败时不替换已有可见版本，后台显示 `content_validation_failed`。源码推送本身不安装部署钩子，也不代表服务器已收到版本。

公开读取：

```text
GET /api/content/catalog
GET /api/content/home
GET /api/content/looks?offset=0&limit=24&model=female-01&region=杭州&q=针织
GET /api/content/looks/{look_id}
GET /api/content/models
GET /api/content/batches
GET /api/content/assets/{asset_id}
GET /api/content/assets/{asset_id}/download
```

完整快照用于前端初始化，列表接口提供分页与过滤。接口仅返回活动版本的 `v2` 和允许公开的资源。`image_url` 默认等于项目图片 `source_url`，例如 `/api/content/assets/look-001-v2-r1`；具体资产 ID 以清单为准。该 URL 返回已归档的同一份 WebP，不暴露文件系统路径。CDN 验证后逐图优先返回 CDN URL，前端失败时单次回退到 `source_url`。

新试穿只接受可见的生动内容，按本地归档裁切实际镜头，在接收任务时冻结参考输入；旧任务保留原记录。收藏仍在浏览器本地，接口分页或不完整列表不能清除未知收藏编号。

## 图床接口与同步状态

尚未选定真实免费图床。默认状态是“未配置”，所有图片继续使用项目 URL；这一状态不会阻塞新内容展示。后台显示活动内容版本、真实任务数量、字节数和同步结果，不伪造已上传比例。

当前通用接入约定是向明确配置的 HTTPS 地址 `PUT` 原始 `image/webp`，发送 `X-Asset-ID`、`X-Content-SHA256` 以及可选 Bearer 凭据，成功响应 JSON `{ "id": "远端标识", "url": "https://允许的域名/图片.webp" }`。它不等于已接入任一家图床；选择平台后按该平台实际协议实现相同的上传与读取接口。

操作方在私有环境调用 `CdnService(YIXU_DATA_DIR).configure(...)`，写入私有 `cdn-config.json`，配置字段为 `upload_url`、`allowed_hosts`、`token`、`timeout_seconds`。不把实际配置、账户或密钥写入仓库；后台只读脱敏配置状态，当前不提供通用凭据编辑页面。外部 agent 无需这些凭据。

上传只处理内容服务明确传入的公开白名单，不扫描用户目录，不同步 v1、自拍或私人试穿结果。远端返回必须满足 HTTPS 主机白名单、无重定向、真实 WebP、尺寸、字节数与哈希一致。当前接入不支持图床重压缩变体；需要变体时先扩展并验证接入约定。

网络读取有字节、像素、socket 超时及传输截止限制；操作方应按选定平台继续验证真实连通与故障行为。上传与崩溃恢复使用进程锁和持久状态；结果未知不自动重传。明确失败可重试，已有远端对象标识的未知任务可仅重新核对，不重新上传。

管理接口均要求管理域、有效登录与修改请求的 CSRF：

```text
GET  /api/admin/content/overview
GET  /api/admin/content/models
POST /api/admin/content/cdn/jobs/{job_id}/retry
POST /api/admin/content/cdn/jobs/{job_id}/verify
POST /api/admin/content/cdn/migrate
```

迁移请求体为 `{ "asset_ids": ["已登记的公开资源编号"] }`。切换默认配置只影响新资产，旧副本继续可用；显式迁移从本地归档创建当前图床的任务，新副本验证前不撤掉旧链接。私有参考图只显示状态，不产生公开预览 URL。用户自拍仍禁止管理员读取。

## 验证与构建

推送前必需：

```sh
node scripts/check.mjs
node qa/regression-expressive.mjs
node scripts/build.mjs
```

完整本地 CI 入口：

```sh
node qa/regression-ci.mjs
```

该入口检查历史与新增资源的签名、尺寸和 SHA-256，运行后端、类型和格式检查、管理界面、真实 Chromium、实际前端到 ASGI、目录导出和部署模板回归。没有真实图床调用或付费生图。新增内容回归在临时目录内测试第 101 套、第二位模特、仅生动、源 URL、引用错误及路径拒绝，不生成虚构生产内容。

构建先验证候选，再替换专用 `public/`。它仅复制页面代码、公开资产并生成离线 catalog，不包含后台、私有数据、原始生成记录或历史造型。文件数量与图片清单动态计算，不再锁定 209 个文件。首次基线的公开图片为 100 张生动九宫格和一张模特基础体。

如仅导出 JSON，运行 `node scripts/export-catalog.mjs --output 输出路径`。后端 schema 改动后重新导出 `Batch.model_json_schema()` 到 `content/batch.schema.json`。

## 历史图片与部署

200 张历史写真于 2026-11-11 从 PNG 转为原尺寸有损 WebP，FFmpeg/libwebp 质量 85、压缩级别 6，总计 48,176,224 字节；原始 PNG 保留在 Git 历史。新增基础体为 1536 × 1024、71,786 字节，未裁剪。新图片采用同样的 WebP 质量起点，实际尺寸和哈希以各自清单为准，不依赖编码器跨版本字节一致。

生产模板及验证步骤见 [deploy/README.md](deploy/README.md)，私人照片处理规则见[试穿实施说明](docs/ai-tryon-backend-design.md)。[Cloudflare 可行性调查](docs/deployment-feasibility.md)是历史参考，不代表当前部署方案。

GitHub Actions 只有读权限，只校验和构建。源码推送、CI、服务端接收、CDN 同步和网站上线分别报告。部署和外部服务配置按项目授权单独执行，本次开发不改变既有主站或私人服务配置。
