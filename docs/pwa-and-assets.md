# PWA 与资源

相关文件：

- `flipgame/site.webmanifest`
- `flipgame/site.local.webmanifest`
- `flipgame/assets/shine-logo.*`
- `flipgame/assets/local-logo.*`
- `flipgame/assets/local-brand.js`

## Logo 规则

页面根据 hostname 自动选择图标：

- `localhost`、`127.0.0.1`、`::1` 使用 local logo。
- 生产环境使用 production logo。

这样可以在手机或浏览器里区分 local app 和 production app。

## Manifest

- 生产环境：`site.webmanifest`
- 本地环境：`site.local.webmanifest`

每个主要 HTML 页面头部都有一段脚本写入 favicon、apple-touch-icon、manifest 和 theme-color。

## App 模式

页面通过以下方式识别 PWA/standalone：

- `display-mode: standalone`
- `display-mode: fullscreen`
- `window.navigator.standalone`

App 模式下的通用目标：

- 防止 iOS 输入框聚焦时缩放。
- 尽量隐藏不必要导航。
- 用左右滑动或主页按钮回到首页。
- 弹窗点击遮罩可关闭。

## 维护注意

- 改 logo 后需要同步 SVG、PNG、ICO 和 manifest 引用。
- 改页面头部资源逻辑时，检查所有 `flipgame/*.html` 的一致性。
- 如果本地页面频繁提示 app update，优先检查 manifest、icon 路径和缓存。
