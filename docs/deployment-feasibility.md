# GitHub + Cloudflare Pages 发布可行性

核查日期：2026-10-23。结论：当前项目可用GitHub仓库管理，再由Cloudflare Pages Git集成发布；图片数量不会阻挡上线。这是发布前的体量调查，Cloudflare 尚未部署；当前仓库准备与构建方式见 DEVELOPMENT.md。

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
