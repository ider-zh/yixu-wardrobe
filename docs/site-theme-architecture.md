# 全站主题

管理员在工作台「网站主题」选择并保存。设置按部署存入私有 SQLite，默认 Editorial。在线访客首次打开、标签页重新可见或从浏览器缓存恢复时读取设置。读取失败或收到未知主题时保留当前布局。离线打开使用 Editorial。

## 代码入口

| 职责 | 代码 |
| --- | --- |
| 主题名称、管理表单与保存反馈 | [admin/index.html](../admin/index.html#L106)、[admin/app.mjs](../admin/app.mjs) |
| 主题校验、SQLite 持久化与表约束迁移 | [backend/store.py](../backend/store.py) |
| 公开读取 `GET /api/site-theme` | [backend/app.py](../backend/app.py) |
| 管理端 `GET`／`PUT /api/admin/site-theme` | [backend/admin.py](../backend/admin.py) |
| 应用主题、发布变更通知、调整节点顺序 | [site-theme.js](../site-theme.js) |
| 全站色彩、排版与响应式布局 | [site-theme.css](../site-theme.css) |
| 首页封面、单品结构与图集交互 | [app.js](../app.js)、[product-themes.js](../product-themes.js)、[product-themes.css](../product-themes.css)、[product-page.js](../product-page.js) |

三个主题接口使用 `{"theme":"editorial"}` 形状，响应禁止缓存。管理读取需要管理员会话，写入还校验来源和 CSRF。管理端在读取或保存确认后调用 `YixuSiteTheme.apply(theme)`，保存失败时保留上次确认的主题。公开页面通过 `resolve()` 和 `subscribe(listener)` 使用当前主题。新增主题时同步维护管理选项、前端白名单、后端 `ThemeName` 和样式。

## 组件约定

- Studio 将首页封面放在文案前，并为管理工作台提供桌面侧栏和窄屏横向导航。后台私有节点始终留在已鉴权的工作区，退出或收到 401 时清理并恢复 Editorial。
- 暗房样片使用当前封面写真展示完整九宫格，并更新其说明和替代文本。其余主题截取封面镜头。
- Studio 单品页使用 `studio`／`neutral-white` 结构和桌面信息侧栏，其余主题使用 `editorial`／`warm-paper` 的内容结构并套用各自的全站样式。两种结构渲染相同的主图、全貌、细节、穿着关联、收藏和推演披露。缩略图按钮至少 44 × 44 像素。
- 切换时保留当前路由、筛选、收藏、产品选图和放大窗。试穿使用原有输入、照片预览、写真选择和排队节点。

## 验证

新增脚本或样式时更新 [site-resources.json](../site-resources.json)。构建、发布核验和开发部署均按该清单校验本地资源路径与符号链接。后台从同源公开根目录加载共享主题脚本和样式。

运行 `node qa/regression-site-theme.mjs` 检查 320、390 和 1440 像素下的主题布局、切换状态及离线回退。接口权限、CSRF 和数据库迁移见 [tests/backend/test_admin.py](../tests/backend/test_admin.py)。
