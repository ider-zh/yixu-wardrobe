# GitHub + Cloudflare Pages 发布可行性

历史核查日期：2026-10-23。当时结论：项目可用GitHub仓库管理，再由Cloudflare Pages Git集成发布；图片数量不会阻挡上线。这是发布前的体量调查。以下至“性能判断”为该日期的历史记录，其中“当前”等表述均指当时状态，图片体量与性能相关意见由文末 2026-11-11 更新取代。维护者已提供站点地址 https://yixu-wardrobe.9992099.xyz/，新域名尚未部署，地址保持不变；当前构建方式见 [DEVELOPMENT.md](../DEVELOPMENT.md)。

## 实测规模

最小网页运行集合为206个文件：200张PNG，以及index.html、app.js、catalog.js、style.css、expressive.css、favicon.svg。总量约532.1 MB，其中图片531661790 bytes，约507.03 MiB。最大图片look-071.png为3272610 bytes，约3.12 MiB。GitHub仓库为 ider-zh/yixu-wardrobe；公开内容由提交清单管理。

## 限制对照

- Pages Free：最多20000个站点文件，单个资产最大25 MiB。当前206文件和最大3.12 MiB均满足。此官方限制页未列整站总字节数硬上限，不能把25 MiB理解为整站限制，也不承诺无限存储。[Cloudflare限制](https://developers.cloudflare.com/pages/platform/limits/)
- Pages免费构建500次/月，一次并行构建，每次20分钟。当前无需框架编译，适合静态HTML托管。[同一官方限制](https://developers.cloudflare.com/pages/platform/limits/)、[静态HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)
- 静态资产请求在免费和付费方案均免费、不限次数。当前站点不需要Pages Functions。[Cloudflare计费](https://developers.cloudflare.com/pages/functions/pricing/)
- GitHub普通Git中单文件超过50 MiB警告，超过100 MiB阻止；仓库建议理想小于1 GB、强烈建议小于5 GB。200张图各约2–3 MB可以普通Git提交，初始图像总量约0.532 GB；反复替换大图会继续累积Git历史。[GitHub大文件](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
- 当前约557 MB的完整ZIP不能作为普通Git文件，也不能作为Pages上的一个可下载静态资产。可作为GitHub Release附件（每个附件小于2 GiB）。[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- Direct Upload另有方式差异：Wrangler最多20000文件，控制台拖放最多1000文件，均限制单资产25 MiB。拖放可接收ZIP或文件夹；ZIP是上传容器，和把ZIP本身作为网站下载资产不同。对于本项目更建议Git集成，或解包后用Wrangler上传，不依赖大ZIP的浏览器上传体验。[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)

## 推荐结构与配置

为写真站创建独立仓库，与浏览器扩展项目分开。发布输出目录public/只包含上述206个网页运行文件；提示词、生成来源、QA、历史版本、压缩包和本地服务器脚本不进入公开网站目录。

Pages选择GitHub Git集成、无框架，构建命令为 node scripts/build.mjs，输出目录public/。以后提交更新即可由Pages部署。所有静态路径使用相对地址，上传独立整合站index.html，不上传依赖相邻文件夹的旧入口兼容页。[官方静态HTML设置](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)

完整ZIP如需在线下载，使用独立Release附件；目前无需为了200张图片引入Git LFS或R2。未来图片达到几千张或频繁整批换图时，再考虑把原图放对象存储，减少Git历史增长。

## 性能判断

当前卡片在CSS里裁切整张九宫格，缩略卡也会请求2–3 MB原图。即使托管限额够用，移动网络浏览大量造型仍会慢。建议上线前新增小尺寸WebP/AVIF预览图，详情打开后再加载PNG原图，保留图片懒加载与CDN缓存。此处是基于本地代码与文件体量的性能判断，不是云端实测结果；尚未生成优化图，也未进行线上测速。

## 2026-11-11 更新：当前图片与备案信息

- 200 张运行时写真已由 PNG 转为原尺寸有损 WebP（质量 85，压缩级别 6）。图片合计从 531,661,790 字节降至 48,176,224 字节，约 48.18 MB，减少 90.94%；单张最大 384,636 字节。48.18 MB 仅为图片体积；当前构建的完整站点为 206 个文件、48,579,000 字节（约 48.58 MB）。
- 网页运行集合仍为 206 个文件。写真仍在网站相对目录 `images/`、`images-v2/` 中，不依赖对象存储或外部 CDN；文档预览改为 `docs/images/wardrobe-preview.webp`，不进入运行集合。原始 PNG 仅保留在 Git 历史中，复现命令见开发说明。
- 本更新取代上述历史记录中的当前资产大小、PNG 加载与尚未压缩的性能意见；采用的是同尺寸压缩，不是新增缩略图或按需加载 PNG 原图。字节数减少不等同于已测得线上速度提升，本次未进行云端测速，也未重新核验 Cloudflare 或 GitHub 的限制、计费与发布可行性。
- 当前版本页脚展示 [浙ICP备2026098002号](https://beian.miit.gov.cn/)。既有在线地址保持不变；仓库更新与新域名部署是不同事项。
