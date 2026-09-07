# 动态攻略库与后台发布

主页按小游戏、公开计算器、免费会员工具箱、VIP 工具箱组织。首页周活动卡直接打开 `GuideImages.html?guide=weekly-current`，攻略图片卡恢复原 `GuideImages.html` 图库入口。VIP 首页文案依次突出觉醒冲榜模拟器、新手攻略、AI 问答；Pro 入口直接打开 `GuideLibrary.html?id=guofeng-pro-v4` 阅读器。免费会员工具箱仍要求注册登录；VIP 工具箱收纳 AI 玩放置、觉醒冲榜和 VIP 攻略，不改变原工具权限。

- 阅读入口：`GuideLibrary.html`，支持 `?category=weekly|public|vip`，按最近发布时间排序。单篇 `?id=<id>`。
- 发布入口：`Admin.html` 左侧“攻略发布” → `GuideAdmin.html`。
- 选择普通、周活动或 VIP 分类，输入标题（可补英文标题），在中文版、英文版两个区域分别多选 JPG/PNG/WebP，检查页序，点击上传并发布。单图最大 3 MB，每种语言最多 100 页，至少提供一种语言。建议文件名补零页码，如 01、02。
- 图片按原字节保存，不重新压缩、不去水印；全部上传完成且检查页引用后才公开。新建攻略上传失败保持草稿；编辑上传失败保持原已发布版本。当前编辑页保留已成功上传的图片引用，重试可继续。
- 点击“编辑”可修改中英文标题、分类、两组图片和页序；新选文件会追加，可预览、上移、下移、移除。保存并发布修改后原 ID 与阅读链接不变。取消编辑不会影响线上原版。可下架或重新发布已有完整攻略。现阶段不提供正文文字编辑、永久删除、定时发布或 PDF 自动转图。
- 旧 `GuideImages.html` 图库保持原样，新图库保留旧图库链接；周活动分类的旧图库链接会打开现有本周图。新上传的周攻略排在该分类顶部。

## 存储与权限

`/api/guides` 使用站点持久 Netlify Blobs `guide-library`，不随代码部署清空。目录 `guides/<uuid>` 是每篇元数据，`assets/<guide-id>/<asset-id>` 是原图。目录列表只公开已发布标题、分类、页数和更新时间；不返回页 ID。每张图片和阅读清单都先读取攻略状态，VIP 分类要求 `canAccessPremium`。草稿仅管理员可查。

创建、上传、发布、下架均复用 first-party BFF 的 `isAdmin`、可信 Origin、双重提交 CSRF。图片设置 private/no-store、CDN no-store、Vary Cookie、nosniff。图片只接受 PNG/JPEG/WebP 签名；不接收 SVG、HTML、任意远程 URL 或路径。页面引用必须属于同篇已上传文件。发布后的图片不可原地覆盖。

前端没有提供任何生产 Local Admin 回退。只有既有 `isStaticMockPreview()` 的 file/:8000 模式使用本地 IndexedDB 演示，绝不调用生产管理 API。连接数据库的 :8888 和线上都必须通过真实账号鉴权。

## 本次国风 Pro PDF

原文件 `国风偷学_Pro版本攻略.pdf`，21 页，21,805,865 字节。采用 200 dpi、JPEG quality 92 按原页渲染；不是重排文字的 HTML。作者图片、水印、页眉页脚均保留，阅读器一次取一页并支持放大，减少首次下载量。原 PDF 未改变，图片不进入公开站点目录。

准备文件在根目录 `output/guide-import/guofeng-pro-v4/`（已忽略 Git），有 `page-01.jpg` 到 `page-21.jpg`。2026-09-07 发布时已将这 21 页导入生产私有 `guide-library` 存储，并逐页核对 SHA-256。正式攻略 ID 固定为 `guofeng-pro-v4`，类别 **VIP**，与首页直达链接一致。原 PDF 未改变，也未上传为公开静态文件。后续修改可直接进入攻略后台，保留 ID。

后续 PDF 转图：

```bash
python3 scripts/prepare-guide-pdf.py '/absolute/path/guide.pdf' --output output/guide-import/new-edition
```

脚本拒绝将私有攻略导出到 `flipgame/`。转换后检查图片、水印和可读性，再后台上传。

## 本地查看

```bash
python3 scripts/preview-guide-library.py
```

打开 `http://127.0.0.1:8000/`。此服务仅绑定本机，静态主页使用原有 Local Admin 预览规则；通过严格限定的 `/__guide-preview/` 路由提供本地 Pro 21 页。此路由只存在于 Python 预览服务，不在生产 API 中。图库/后台的演示上传只写当前浏览器 IndexedDB，刷新或换页仍可查看。关闭浏览器的清理策略可能删除演示数据。

首次功能随 main 代码发布；之后后台上传与编辑无需再发布代码。

## 双语与修改（2026-09-07）

旧 pages 字段兼容为中文版，新增 pagesEn 为英文版；旧数据无须迁移。读者跟随站点语言选择图片；没有对应版本时回退到另一种语言，并显示 Chinese edition only 或“仅英文版”。英文标题不会被当作英文图片的标记。

管理员可向已发布攻略上传不可覆盖的新图片，但新图只有在 manifest 成功保存后才对读者开放。edit 请求携带 revision，读取最新对象并用 Blobs ETag / onlyIfMatch 原子替换整篇元数据；过期 revision 或并发变化返回 409。标题、权限分类、两组图片一次生效，移除的原图不能继续通过公共阅读接口请求。旧文件物理保留，不提供永久清理功能。

## 周攻略自动联动（2026-09-07）

管理员发布 category=weekly 的攻略后，首页周攻略卡的说明自动显示最新已发布标题；点击仍进入原 GuideImages.html?guide=weekly-current 并直接打开最新一期。原图库周攻略卡显示最新封面，点击集合自动合并后台历期与原有静态历史图片。两处无需再手工维护图片路径。

按首次/重新发布时间 publishedAt 排序；修改已发布旧期保留发布时间，不会置顶。新一期下架后回退上一已发布期，全部下架或后台读取失败时回退原静态本周图和历史集合。进入页面或浏览器返回恢复时刷新数据，不进行后台轮询。英文站选英文图，缺英文图时明确提示 Chinese edition only。新上传的单期支持多张图片。

现有静态历史内容继续保留。该联动仅涉及周攻略，不把 VIP 攻略图片混入公开图库。
