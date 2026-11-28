# 衣序开发指南

## 本地浏览与验证

使用 Node.js 22。完整验证还需要 Python 3.12、`uv` 与 Chromium，依赖由 [pyproject.toml](pyproject.toml) 和 [uv.lock](uv.lock) 固定。

```sh
node scripts/check.mjs
node qa/regression-expressive.mjs
node scripts/build.mjs
```

打开 `public/index.html` 可离线浏览，或运行 `node serve.mjs` 访问本机 `http://127.0.0.1:4219/`。构建根据内容清单和 [静态资源白名单](site-resources.json) 生成 `public/catalog.js` 并复制公开资源。指定 `--output <空目录>` 可构建独立候选。独立 JSON 导出使用 `node scripts/export-catalog.mjs --output <文件>`。

运行 `node qa/regression-ci.mjs` 执行完整回归，覆盖 Python 后端、后台交互、真实 Chromium、前端与 ASGI 联动、目录导出与发布模板。可通过 `CHROME_BIN` 指定本地浏览器，完整入口会按固定摘要核验测试用检测器。常规 GitHub Actions 只读验证和构建。

## 代码入口

| 要改什么 | 从这里开始 |
| --- | --- |
| 首页、全部穿搭、模特、收藏、路由、九宫格 | [index.html](index.html)、[app.js](app.js)、[style.css](style.css)、[expressive.css](expressive.css) |
| 单品详情、图集、布局 | [product-page.js](product-page.js)、[product-themes.js](product-themes.js)、[product-themes.css](product-themes.css) |
| 全站主题、后台设置和共享资源 | [主题规范](docs/site-theme-architecture.md)、[site-theme.js](site-theme.js)、[site-theme.css](site-theme.css)、[site-resources.json](site-resources.json) |
| 首页、卡片与画册动效、桌面滚轮 | [site-motion.js](site-motion.js)、[site-motion.css](site-motion.css) |
| 试穿界面、同源浏览器副本、后端队列 | [tryon.js](tryon.js)、[tryon-storage.js](tryon-storage.js)、[tryon.css](tryon.css)、[backend/jobs.py](backend/jobs.py)、[backend/worker.py](backend/worker.py) |
| 内容清单、构建与资源 API | [内容架构与发布](docs/content-publishing-plan.md)、[scripts/content-lib.mjs](scripts/content-lib.mjs)、[backend/content.py](backend/content.py) |
| 后台、访问分析、CDN 与运行配置 | [admin/](admin/)、[后端说明](backend/README.md)、[backend/analytics.py](backend/analytics.py)、[backend/cdn.py](backend/cdn.py) |

## 浏览动效

[GSAP 3.15.1](https://www.npmjs.com/package/gsap/v/3.15.1) 和 [Lenis 1.3.29](https://www.npmjs.com/package/lenis/v/1.3.29) 使用官方 npm 包内的浏览器压缩发行文件，通过相对路径加载，支持离线浏览。升级时保留 GSAP 的原始许可声明及 Lenis 的 MIT 许可，更新 [静态资源白名单](site-resources.json) 与 HTML 引用。卡片参考 [React Bits Animated Content](https://reactbits.dev/animations/animated-content) 的进入视口、短距离上移、错峰呈现方式，由站点的 GSAP 代码实现。

使用 `node qa/regression-homepage.mjs` 验证动效及浏览行为，覆盖桌面滚轮、触屏原生滚动、弹窗内部滚动、路由复位和实时切换系统减少动态效果设置。

## 内容与发布

制作穿搭先读[外部 agent SOP](docs/external-agent-sop.md)，使用 `node scripts/resolve-model.mjs "<模特编号或名称>"` 解析登记参考与角色规范。单品制作见[单品 SOP](docs/product-agent-sop.md)。批次、写真修订、单品和模特清单的维护入口见[内容架构](docs/content-publishing-plan.md)。

场景专题在 [wardrobe-scenes.js](wardrobe-scenes.js) 维护。每个专题按展示顺序引用 4–6 套可全站索引且写真就绪的穿搭，并为每套写一条具体搭法。运行 `node scripts/check.mjs` 校验穿搭编号与静态资源清单。

在 `dev` 分支迭代。开发环境在 CI 通过后通过独立服务构建、导入并核验 `https://dev-yixu.8882088.xyz/` 及同源 `/admin/`。开发站流程见[开发站部署](deploy/dev-README.md)，正式交付另循[部署说明](deploy/README.md)。源码推送、CI、站点内容/图片验收和 CDN 同步各有独立结果。

## 单品主题与内容合同

[products.schema.json](content/products.schema.json) 约束单品数据。[product-page.js](product-page.js) 统一处理图集、穿着参考、设计推演、图片回源和收藏。外部交付使用纯文本与结构化图片，主题由全站设置决定。

单品 `copy` 可逐项提供 `hero_title`、`views_title`、`details_title`、`worn_title`、`related_title`。每项有值时为 1–200 字符的非空白纯文本，省略则使用页面默认标题。快照和 API 保留已有 `presentation.theme` 和可选 `presentation.preset`（匹配 `^[a-z][a-z0-9-]{0,63}$`），省略时使用 `theme: editorial`。实际页面由全站 Studio 选择侧栏结构，其余主题使用 Editorial 结构。
