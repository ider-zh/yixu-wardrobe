# 正式站模板与本地交付

日常变更走 `dev`，由[开发站发布流程](dev-README.md)处理。正式站升级需单独授权。本目录的正式站 Nginx 模板使用 `www.8882088.xyz` 与独立后台 `admin.8882088.xyz`。

## 正式站模板

```sh
python3 deploy/render.py \
  --output "$PRIVATE_STAGE/config" \
  --web-root "$PUBLIC_RELEASE/public" \
  --backend-root "$BACKEND_RELEASE" \
  --data-root "$PRIVATE_STATE" \
  --runtime-env "$PRIVATE_SETTINGS/runtime.env" \
  --api-port 8765
```

[render.py](render.py) 读取 [site.conf](site.conf)、[admin.conf](admin.conf) 和三个服务模板。所有路径使用绝对路径。主站 Web 根目录指向 `node scripts/build.mjs` 生成的 `public/`，后台 Web 根目录指向后端版本内的 `admin/`。部署环境的 `YIXU_CONTENT_ROOT` 指向版本目录的 `content/`，`YIXU_IMAGE_ROOT` 指向包含清单相对资源路径的版本目录或公开构建目录，`YIXU_DATA_DIR` 使用版本目录外的私有持久状态。其他设置见[后端说明](../backend/README.md)。

- [yixu-api.service](yixu-api.service) 与 [yixu-worker.service](yixu-worker.service) 使用同一代码和环境文件。服务用户只写私有状态，运行时解释器须在 `ProtectHome=true` 下可见。Nginx 覆写转发头，API 只监听回环并按 Host 检查角色，主站封锁管理 API。
- [yixu-egress.service](yixu-egress.service) 使用专用传输配置。仅监听回环，`allow-lan: false`，使用明确授权的出口。凭据放私有目录，系统路由和全局代理由现场原配置管理。
- 部署前使用 `nginx -t` 和 `systemd-analyze verify` 检查模板，保留上一个应用版本供回退，受控停止 Worker 再切换应用代码。私有自拍输入不纳入备份。
- 切换后验证两站可信 HTTPS、证书匹配及续期、官网目录与静态快照版本一致、主推源图哈希、管理鉴权、成品所有权、API/代理回环监听和真实检测器。实际生成和成本验证需要明确授权和同意后的输入。

## 授权环境的本地交付

[release.mjs](../scripts/release.mjs) 针对已部署且授权的本地安装。要求干净、已提交的工作区，静态服务器使用该工作区的 `public/`，指定 API 使用同一内容清单和私有状态目录。

```sh
node scripts/release.mjs \
  --public-url "$PUBLIC_ORIGIN" \
  --api-unit yixu-local-api.service \
  --data-dir "$PRIVATE_STATE" \
  --systemd-user
```

默认只验证并构建候选。授权切换时加入 `--activate`，脚本更新 `public/` 并只重启指定的 `yixu-*api` 服务。验证包括 API/静态内容版本和首页主推、[核心公开文件清单](../site-resources.json)，以及主推图片同源 WebP 的 MIME、字节数和 SHA-256。面向同源后台部署的鉴权和核心后台文件验证由[开发站控制器](dev-release.py)执行。

验证成功才写入私有 `publication.json`。公开 `/api/content/publication` 和后台内容概览根据当前版本及主推资源判断回执是否有效，CDN 同步独立报告。切换失败恢复上一静态目录并标记验证失败，旧回执存为 `publication.previous.json`；若 API 已导入新版本，需要核对后重试。私有数据库不回滚。两个目录改名之间可能短暂缺少静态根。进程异常终止留下 `release.lock` 时，先核对 `owner.json` 记录的进程。

授权本地环境可在命令中加 `--activate --watch`，默认每五秒检查当前工作区的已提交 HEAD。观察器跳过脏工作区及已验证 SHA，用同一把锁串行交付，每次运行对同一失败 SHA 只尝试一次，并在 `release-watch.json` 记录结果。它不拉取远端；开发服务器使用独立的发布控制器。

## 验证入口

```sh
node qa/regression-deploy.mjs
node --test qa/regression-release.mjs
uv run pytest tests/backend/test_release_publication.py
node qa/regression-ci.mjs
```

[GitHub Actions](../.github/workflows/check.yml) 执行验证和构建。实际发布以目标站点检查及对应回执为准。
