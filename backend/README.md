# API、管理后台与试穿 Worker

## 启动

在仓库根目录运行。API 与生成 Worker 各启动一个进程，共用私有数据目录和运行设置。代理和环境配置见[正式站模板与本地交付](../deploy/README.md)及[开发站发布](../deploy/dev-README.md)。

```sh
uv sync --locked
export YIXU_DATA_DIR=/path/to/private/yixu
export YIXU_CONTENT_ROOT="$PWD/content"
export YIXU_IMAGE_ROOT="$PWD"
export YIXU_FACE_MODEL=/path/to/models/yunet.onnx
export YIXU_PUBLIC_HOST=127.0.0.1:8010
export YIXU_ADMIN_HOST=127.0.0.1:8010
export YIXU_SECURE_COOKIES=false
uv run uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8010 --workers 1 --no-access-log
# 另开一个终端，沿用同一套环境变量
uv run python -m backend.worker
```

以上 Host 和 Cookie 配置供本地 HTTP 使用。正式环境启用默认的 Secure Cookie，反代覆写 Host 和转发头，Uvicorn 只信任本机代理。同源后台令两个 Host 相同，独立后台令两者分别匹配各自域名。访客和管理员的 HttpOnly Cookie 分开，管理 Cookie 限于 `/api/admin`，写操作校验同源及 CSRF。未设置 `YIXU_COOKIE_MAX_AGE` 时使用会话 Cookie。

首次创建应用会初始化 SQLite 并生成私有的 `initial-admin.json`（目录 0700、文件 0600）。操作者在服务器上本地读取，避免写入日志。重启不会重置密码，密码轮换撤销已有管理员会话。初始文件作为初始化回执保留旧值，确认安全保存账号后可删除。密码使用 Argon2 哈希。配置定义见 [settings.py](settings.py)，会话与存储见 [app.py](app.py)、[admin.py](admin.py) 和 [store.py](store.py)。

## 查找代码

| 用途 | 入口 |
| --- | --- |
| 公开目录、首页、穿搭、模特、单品与源图 | [content.py](content.py) · `/api/content/` |
| CDN 接入、同步和后台模特预览 | [cdn.py](cdn.py)、[cdn_worker.py](cdn_worker.py)、[content_admin.py](content_admin.py) · `/api/admin/content/` |
| 发布回执与当前内容版本校验 | [publication.py](publication.py) · `/api/content/publication` |
| 管理登录、成品评估、主题与生成设置 | [admin/app.mjs](../admin/app.mjs)、[admin.py](admin.py) · `/api/admin/` |
| 浏览凭证、处理同意和可用性 | [app.py](app.py) · `/api/bootstrap`、`/api/disclosure/accept` |
| 提交、排队、状态、下载和删除 | [tryon.js](../tryon.js)、[jobs.py](jobs.py) · `/api/tryons` |
| 浏览器照片库与成品缓存 | [tryon-storage.js](../tryon-storage.js) |
| 输入校验、成品编码与后台预览遮盖 | [images.py](images.py) |
| 单 Worker 调度、失效清理和外部接口 | [worker.py](worker.py)、[provider.py](provider.py) |
| 访问事件与离线地域 | [analytics.py](analytics.py)、[geolocation.py](geolocation.py) · `/api/events` |

启动时验证内容清单和 WebP，合格资源存入 `YIXU_DATA_DIR/public-content`，导入失败则沿用最近有效版本。公开资源由同源 `source_url` 提供，CDN 通过同步和校验后才优先使用，独立于私有生成。试穿新请求和访问事件只接受生动版选择，历史任务照常按所有者读取。独立目录模式使用显式传入的 `Settings.catalog_path` 和 `catalog_image_root`，JSON 格式见 [export-catalog.mjs](../scripts/export-catalog.mjs)。资源与图床流程见[内容发布说明](../docs/content-publishing-plan.md)。

## 试穿与隐私

- 首次试穿需主动同意当前版本的照片披露，才可上传。用户选择当前穿搭及一个镜头，服务端冻结选择并裁切单格参考。单图沿用原照片的姿态，九宫格以照片为人物参考，生成统一棚拍场景下的九种全身站姿。历史九宫格嵌入的中央原图仍在管理员预览中遮盖。
- 浏览器 IndexedDB 可保留用户管理的照片、任务记录和已取得成品。清理站点数据会移除本机副本，清理 Cookie 会丢失原服务端所有者凭证。离线仍可查看已取得成品。删除任务会清除本机成品，并在服务端可达时同步删除。
- 上传在受限内存中解析。解码纠正方向、移除元数据，使用本地 YuNet 验证单个可用人脸，必要时在有限重叠区域补检。上传字节、像素、尺寸、并发、最小人脸尺寸和置信度都在 [Settings](settings.py) 配置；其他 JSON 写入有 64 KiB 技术限制。
- 输入从接收上传起最多保留一小时，独立清理循环及启动对账覆盖排队和异常。Worker 在调用外部接口前移除磁盘输入，调用超时受剩余输入寿命限制。过期的未发任务进入 `needs_photo`，由用户显式重新提交。API 和 Worker 应持续受监督运行，主机停机期间的文件由启动清理处理。
- SQLite 持久化按所有者隔离的队列。同一幂等键和相同内容返回已有任务，内容变化返回 409。单 Worker 使用进程锁，发送前记录可能发送状态。取消在派发决定前生效，之后丢弃返回结果。交付不明进入 `unknown`，重启也不自动重放；确定失败进入 `failed`。
- 私有成品为带可见 AI 标识与 XMP 生成来源的 WebP，按完成顺序滚动保留最新 1,000 张，无成品时间到期。成品读取与下载校验所有者，管理员可评估生成成品，评估是可选操作。输入、试穿成品、账号和设置保存在私有目录，禁止进入 Git、静态包及公共 CDN。原始输入不纳入备份。
- 生成并发、网络与解析限制用于保护实际运行。业务侧不设置生成次数、费用预算、IP 配额或排队时限。

## 外部生成与访问统计

从后台配置明确授权的项目 Key、模型、HTTPS 接口和显式 loopback HTTP 代理。`runtime.json` 私有保存，空 Key 保留原值，`clear_api_key:true` 清除。SDK 图像编辑接收归一化照片和单格参考，输出一张图。模型、画幅、质量和请求超时可配置，默认 1024×1536、high。调用只走配置的代理，禁用 SDK 重试。缺少内容、检测器或可用配置时明确显示生成不可用。

第一方事件仅接收 `page_view`、`look_open`、`tryon_open` 及受控选择字段，按访客及事件 ID 去重。任务数、结果状态和容量源自服务端。访问地域仅对新浏览事件查本地 MMDB，保存国家及中国省级区域等粗粒度信息，后台统计按各区域的浏览凭证去重。IP、UA、照片、凭据及详细位置不进入事件存储。

离线地域库默认为私有目录的 `geoip/city.mmdb`，或用 `YIXU_GEOIP_DATABASE` 指定。用 `maxminddb.open_database` 验证临时文件后原子替换，服务会检测更新。缺少库时显示未知，历史事件不回填。后台保留 [DB-IP City Lite](https://db-ip.com/db/download/ip-to-city-lite) 署名。

## 验证

```sh
uv run pytest tests/backend -q
uv run ruff check backend tests/backend
uv run ruff format --check backend tests/backend
uv run mypy backend
node qa/regression-ci.mjs
```

应用回归使用受控提供方和浏览器，覆盖任务恢复、权限、清理和本机工作台。完整回归可用 `CHROME_BIN` 指定 Chromium，用 `YIXU_TEST_FACE_MODEL` 指定已核验的 YuNet 模型。官方模型固定版本及摘要见 [verify-application.mjs](../scripts/verify-application.mjs)。
