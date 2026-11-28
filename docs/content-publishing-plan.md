# 内容发布、资源 API 与 CDN

内容维护从[穿搭制作 SOP](external-agent-sop.md)和[单品制作 SOP](product-agent-sop.md)进入。后台读取项目交付的内容，提供系统模特预览、发布验收回执与 CDN 同步操作。

## 内容入口

| 内容 | 文件与约定 |
| --- | --- |
| 初始生动穿搭与风格分类 | [content/catalog.json](../content/catalog.json)。作为基础目录保留稳定编号、单品顺序与原生动写真，历史条目沿用无发布日期。 |
| 系统模特 | [content/models.json](../content/models.json) 记录稳定 `model_id`、显示名、参考资源和可选制作 SOP，由 [resolve-model.mjs](../scripts/resolve-model.mjs) 解析。 |
| 日更 | [content/batches/](../content/batches/) 按 [batch.schema.json](../content/batch.schema.json) 追加，图存入 `assets/looks/YYYY-MM-DD/`。 |
| 基础写真修订 | [content/look-revisions.json](../content/look-revisions.json) 每个基础穿搭最多登记一个当前修订，`replaces_asset_id` 指向原生动资产。修订使用新 WebP 和资产 ID，原版仍可按资源链接访问，同步更新单品的写真引用。 |
| 画册主图 | 日更穿搭在批次的单套记录填写 `editorial_asset`。历史穿搭使用 `content/look-editorials.json`，文件包含 `schema_version: 1` 和 `editorials` 数组。每条包含 `look_id`、指向当前九宫格的 `reference_asset_id` 以及主图 `asset`。 |
| 单品 | [content/products.json](../content/products.json) 与 [products.schema.json](../content/products.schema.json)，图存入 `assets/products/`。以 `look_id`、`piece_index`、`reference_asset_id` 和 `shot_index` 精确关联当前成片。 |

画册主图使用 `assets/looks/` 下独立的公开 2:3 单帧 WebP，登记标准资源元数据。历史条目如有写真修订，以新九宫格作为主图和单品的制作参考。已有登记模特使用对应身份参考，历史未登记模特保留空值。使用已有九宫格核对人物和衣装，缺少可确认的面部参考时沿用画册的写真封面镜头。

主图上可辨认的单品在 [wardrobe-lookbook-pins.js](../wardrobe-lookbook-pins.js) 配置锚点。以主图资源 ID 和从 1 开始的单品序号关联，`[x, y]` 是从原图左上角量起的宽、高百分比。更换主图时请按新图重新定位。被遮挡或出画的单品从画册内的单品列表进入。

画册视觉配置按穿搭编号写入 [wardrobe-lookbook-designs.js](../wardrobe-lookbook-designs.js)。根据每套衣装和写真场景选择版式、标题字形、画框、背景纹理和颜色。第 112 套使用原试点样式。样式规则在 [lookbook-design.css](../lookbook-design.css)。

## 从清单到前端

- [scripts/content-lib.mjs](../scripts/content-lib.mjs) 和 [backend/content.py](../backend/content.py) 分别校验构建与服务端导入的数据。两端按清单内容生成同一 `revision`。服务端验证图片并按 SHA-256 存储，通过 SQLite 原子切换活动版本；导入失败继续提供上一个可用版本。已登记的 `asset_id` 对应固定字节。
- [scripts/build.mjs](../scripts/build.mjs) 从 [site-resources.json](../site-resources.json) 与已登记的公开资源构建 `public/`，生成 `public/catalog.js`，可直接打开 `public/index.html` 离线使用。[scripts/export-catalog.mjs](../scripts/export-catalog.mjs) 可另行导出 JSON。[app.js](../app.js) 先读取静态快照，在线时接受同版本的 `/api/content/catalog`，版本不符或请求失败时继续使用可用快照。
- 最新可索引批次决定首页封面，最近更新跳过封面并最多展示六套。批次按明确的发布时间排序，省略时取上海发布日期零点。衣橱筛选只影响列表。穿搭详情 `#look-<id>` 与收藏沿用原数字 ID，单品 `#/product/<product_id>` 使用独立的 ID 和收藏。
- `model_only: true` 允许从对应模特页浏览，排除在首页、全站穿搭列表与相关筛选、风格漫游、收藏列表、穿搭对比和批次索引之外。只有模特专属关联的单品同样从全站单品列表隐藏。完整快照、按 ID 查询和资源链接仍可公开访问。

## API、资源回源与交付

- [backend/content.py](../backend/content.py) 暴露 `/api/content/` 下的 `catalog`、`home`、`looks`、`models`、`products`、`batches`、`assets/{asset_id}` 和独立下载入口。穿搭和模特穿搭列表支持分页，穿搭及单品也支持按 ID 查询。
- [backend/cdn.py](../backend/cdn.py) 与 [backend/cdn_worker.py](../backend/cdn_worker.py) 持久化同步任务，验证远端资源后逐图提供 CDN 地址。`source_url` 始终指向项目资源；[app.js](../app.js) 在 CDN 加载失败时单次回源，项目图也不可用时展示缺图状态。[backend/content_admin.py](../backend/content_admin.py) 提供鉴权的内容版本、模特预览、同步查看、重试、核对和迁移操作。用户私有数据独立存放。
- 通用 CDN 接入由服务端私有配置指定 `upload_url`、`allowed_hosts`、`token` 和 `timeout_seconds`。上传以 HTTPS PUT 发送原始 WebP，带 `X-Asset-ID`、`X-Content-SHA256` 及可选 Bearer 凭据，响应含 `id` 和 `url`。核验拒绝重定向及重压缩结果。结果不明时可按已有远端标识重新核验，既有可用副本保留至迁移副本核验成功。
- [scripts/release.mjs](../scripts/release.mjs) 支持显式交付和授权本地观察器。开发站由 [deploy/dev-release.py](../deploy/dev-release.py) 接收 CI 通过的 `dev` 提交。发布核验看静态包、API 与图片的实际结果，回执与 CDN 状态分开查看。执行命令见[部署说明](../deploy/README.md)和[开发站说明](../deploy/dev-README.md)。
- 清单和版本回归见 [qa/regression-content.mjs](../qa/regression-content.mjs) 与 [tests/backend/test_content.py](../tests/backend/test_content.py)，资源回源见 [tests/backend/test_cdn.py](../tests/backend/test_cdn.py)。
