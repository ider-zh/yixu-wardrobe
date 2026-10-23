# 衣序开发说明

仓库：[ider-zh/yixu-wardrobe](https://github.com/ider-zh/yixu-wardrobe)。用户使用说明见 [中文 README](README.md) 和 [English README](README.en.md)，维护授权见 [AGENTS.md](AGENTS.md)。

## 本地运行

项目为无依赖的静态 HTML/CSS/JavaScript 网站。完整下载后可直接打开 `index.html`。需要 HTTP 预览时，使用 Node.js 22 或更新版本：

```sh
node serve.mjs
```

打开 http://127.0.0.1:4219，结束进程停止服务。无需 npm 安装。

## 文件与修改

- `index.html`、`app.js`、`style.css`、`expressive.css`：页面、交互与样式。
- `catalog.js`：100 套服装的完整前台资料。修改文案、分类或镜头描述时编辑此文件；保持服装 ID、顺序和图片对应关系。
- `images/`、`images-v2/`：造型与生动写真，各 100 张九宫格 PNG。内部 v1/v2 标记用于对应关系，界面使用“造型”和“生动”。
- `image-manifest-all.json`：200 张图的尺寸、字节数和 SHA-256。替换图片时审阅并更新对应清单。
- `qa/regression-expressive.mjs`：使用实际应用代码和合成 DOM 检查交互。
- `scripts/`：无外部依赖的校验和静态输出脚本。

本地生成提示词、原始来源记录、历史草稿及完整 ZIP 不属于公开仓库内容；`.gitignore` 使用文件清单控制提交范围。

## 验证与构建

推送前运行：

```sh
node --check app.js
node scripts/check.mjs
node qa/regression-expressive.mjs
node scripts/build.mjs
```

检查覆盖 100 套、10 组各 10 套、200 张图片的签名与 SHA-256、资源和文档链接。交互回归检查筛选、季节单选、写真切换、收藏、对比与详情导航；布局、焦点和原生弹窗行为仍需浏览器验证。

构建会替换专用的 `public/` 输出目录，只复制网页必需的 206 个文件，不包含文档、测试和生成记录。该目录不提交到 Git。GitHub Actions 执行同样的检查与构建，只有读取权限，不发布站点或 Release。

## 托管准备

[GitHub + Cloudflare Pages 可行性调查](docs/deployment-feasibility.md)记录了图片体量、官方限制和性能考虑。若另行授权部署，可使用 Cloudflare Pages Git 集成：

- 框架：None。
- 构建命令：`node scripts/build.mjs`。
- 输出目录：`public`。
- 根目录：仓库根目录。

源码推送与 Cloudflare 部署分别报告，仓库存在及 CI 通过都不代表网站已经上线。
