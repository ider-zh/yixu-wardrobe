# 衣序开发说明

仓库：[ider-zh/yixu-wardrobe](https://github.com/ider-zh/yixu-wardrobe)。用户使用说明见 [中文 README](README.md) 和 [English README](README.en.md)，维护授权见 [AGENTS.md](AGENTS.md)。

## 内容生产与待实施改造

外部 agent 的日更操作见[热点穿搭生产 SOP](docs/external-agent-sop.md)，后台职责、代码驱动内容、资源 API 与自动 CDN 同步的实施顺序见[内容发布开发计划](docs/content-publishing-plan.md)。新增内容目标为每日一个批次、仅生动九宫格，首位模特使用现有 female-01 基础体；历史造型归档保留但目标公开网站不展示。用户私有数据不进入公共资源同步范围。

两份文档描述的是待实施流程。当前代码仍固定 100 套、双写真与本地图片，尚无动态内容接收或 CDN 同步入口；下文对应现有运行版本。首次日更追加前须先完成动态内容与资源 API 改造，不应把文档示例当作已存在的脚本或接口。

## 本地运行

项目为无依赖的静态 HTML/CSS/JavaScript 网站。完整下载后可直接打开 `index.html`。需要 HTTP 预览时，使用 Node.js 22 或更新版本：

```sh
node serve.mjs
```

打开 http://127.0.0.1:4219，结束进程停止服务。无需 npm 安装。

## 文件与修改

- `index.html`、`app.js`、`style.css`、`expressive.css`：页面、交互与样式。
- `catalog.js`：100 套服装的完整前台资料。修改文案、分类或镜头描述时编辑此文件；保持服装 ID、顺序和图片对应关系。
- `images/`、`images-v2/`：造型与生动写真，各 100 张原尺寸有损 WebP 九宫格（质量 85，压缩级别 6）。内部 v1/v2 标记用于对应关系，界面使用“造型”和“生动”；运行时继续使用这两个相对目录，不依赖对象存储或外部 CDN。
- `assets/model-bases/female-01.webp`：女模特 01 的正面、前侧、侧面、后侧和背面五视角基础体参考图，保持完整画幅与标注；作为资源随构建分发，尚未接入页面交互。
- `image-manifest-all.json`：200 张写真及 `modelBases` 基础体参考图的尺寸、字节数和 SHA-256。替换图片时审阅并更新对应清单。
- `docs/images/wardrobe-preview.webp`：文档预览图，不进入网页运行集合。
- `qa/regression-expressive.mjs`：使用实际应用代码和合成 DOM 检查交互，结束后调用资源回归，现有 CI 入口会同时运行两组检查。
- `qa/regression-assets.mjs`：可独立运行的构建产物、图片完整性拒绝和 HTTP 类型回归。
- `scripts/`：无外部依赖的校验和静态输出脚本。

本地生成提示词、原始来源记录、历史草稿及完整 ZIP 不属于公开仓库内容；`.gitignore` 使用文件清单控制提交范围。

## 图片压缩与复现

2026-11-11，200 张运行时写真由 PNG 转为原尺寸有损 WebP，使用 FFmpeg 的 `libwebp` 编码器，质量 85、压缩级别 6，不缩放。图片合计从 531,661,790 字节降至 48,176,224 字节（约 48.18 MB），减少 90.94%，单张最大 384,636 字节。该图片总数不含文档预览和基础体参考图。

2026-11-12，新增用户提供的女模特五视角换装基础体。使用 Pillow 的 WebP 编码器以 `quality=85, method=6` 转码，不缩放、不裁剪、不重绘，保留 1536 × 1024 尺寸；文件从 PNG 的 2,035,562 字节压缩至 WebP 的 71,786 字节，减少 96.47%。仅提交 WebP，原始 PNG 不进入 Git。该图单独记录在清单的 `modelBases` 中，不计入 100 套服装或 200 张写真。当前构建为 209 个文件、48,670,228 字节。

200 张写真的原始 PNG 保留在 Git 历史中，不在当前图片目录中。以下 Bash 命令从已知包含原始 PNG 的提交读取源文件，在单独目录重建写真和文档预览，不覆盖当前资产；需要 Git 和带 `libwebp` 编码器的 FFmpeg。这些是维护工具，不是网站运行依赖。

```bash
set -euo pipefail
source_revision=3495260326e5cb72120ed165bab0910c8ee34d9d
output_dir="$PWD/webp-rebuilt"
git ls-tree -r --name-only "$source_revision" -- images/ images-v2/ docs/images/ |
while IFS= read -r source; do
  case "$source" in
    *.png)
      target="$output_dir/${source%.png}.webp"
      mkdir -p "$(dirname "$target")"
      git show "$source_revision:$source" |
        ffmpeg -hide_banner -loglevel error -n -i pipe:0 \
          -c:v libwebp -lossless 0 -quality 85 -compression_level 6 \
          -frames:v 1 -f webp "$target"
      ;;
  esac
done
```

编码器版本变化可能影响输出字节；复现后应核对尺寸和画面，不能假定生成结果与清单哈希自动一致。正式替换时同步修改 `catalog.js` 和清单，并运行以下校验；不要把重建目录作为额外运行资产发布。

## 验证与构建

推送前运行：

```sh
node --check app.js
node scripts/check.mjs
node qa/regression-expressive.mjs
node qa/regression-assets.mjs
node scripts/build.mjs
```

检查覆盖 100 套、10 组各 10 套、200 张写真及基础体参考图的 RIFF/WebP 与 VP8 头、RIFF/块长度、文件字节数、头部尺寸与清单一致性及 SHA-256，以及资源和文档链接。图片校验仅接受单帧、单个 VP8 块的简单有损 WebP，不是支持所有 WebP 变体的通用解码器。资源回归另查构建产物、重算哈希后的坏签名/长度/尺寸拒绝、图片哈希变化拒绝，以及 HTTP 预览的 `image/webp` 类型和实际字节。交互回归检查筛选、季节单选、写真切换、收藏、对比与详情导航；布局、焦点和原生弹窗行为仍需浏览器验证。

构建会替换专用的 `public/` 输出目录，只复制网页和基础体资源的 209 个文件，不包含文档、测试和生成记录。该目录不提交到 Git。GitHub Actions 执行同样的检查与构建，只有读取权限，不发布站点或 Release。

## 当前托管与静态托管参考

[衣序在线衣橱](https://www.8882088.xyz/)现已直连部署，使用 Nginx 提供已逐文件核验的静态构建，HTTP 跳转 HTTPS，Certbot 自动续期及续期后重载已配置，并以实际 systemd 服务完成续期演练。私人运维资料和凭据保留在服务器私有目录，不进入本仓库。当前版本页脚使用备案号 [浙ICP备2026098002号](https://beian.miit.gov.cn/)。

[GitHub + Cloudflare Pages 可行性调查](docs/deployment-feasibility.md)保留了 2026-10-23 的历史调查和 2026-11-11 的图片更新，不作为当前主站部署方式。以下 Cloudflare Pages Git 集成配置仅作替代静态托管参考；本次未重新核验其云服务商限制或线上性能：

- 框架：None。
- 构建命令：`node scripts/build.mjs`。
- 输出目录：`public`。
- 根目录：仓库根目录。

源码推送与 Cloudflare 部署分别报告，仓库存在及 CI 通过都不代表网站已经上线。

## 后续后台设计（未实现）

见[匿名 AI 试穿与第一方 Web Analytics 后台设计](docs/ai-tryon-backend-design.md)。方案保留静态衣柜和本地收藏，拟增加同源轻量后台、任务队列、本地人像检测、私有 WebP 结果及受限出站代理；未开放自拍上传或收费模型调用。实施前应根据新的明确授权，窄化更新 `AGENTS.md` 中原先禁止分析与上传的规则，并完成方案中的资格、隐私和预算条件。
