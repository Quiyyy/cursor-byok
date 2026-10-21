# 资产说明

资产与当前产品界面一同维护，说明、截图和品牌入口不依赖个人站点。

## 资产清单

| 路径 | 用途 | 更新方式 |
| --- | --- | --- |
| `apps/desktop/src-tauri/icons/icon.svg` | Cursor BYOK 应用图标源文件 | 修改此文件后重新生成平台图标 |
| `apps/desktop/src-tauri/icons/*.png`、`*.ico`、`*.icns` | 窗口、托盘与安装包图标 | 由 Tauri icon 工具生成 |
| `images/*-zh.png`、`images/*-en.png` | 概览、模型和账号页截图 | 从当前前端演示模式重新截图 |
| `apps/desktop/src/shared/assets/icons/` | Cursor 产品识别图形 | 仅用于识别对应产品 |
| `apps/desktop/src/shared/assets/provider-icons/` | 服务商品牌标识 | 保持对应服务含义，不作为项目品牌使用 |
| `server/plugins/build-in/*/assets/` | 内置账号插件图标 | 随对应插件更新 |
| `apps/desktop/src/shared/assets/fonts/` | 当前 UI 字体资源 | 单独核对字体来源和分发许可 |
| `server/prompt/cursor/commit/` | 独立 Commit 生成模板 | 保持语义与 LF 换行 |
| `server/native-agent/install.bundle.mjs` | 本项目原生入口安装器及依赖 | 使用 `node server/native-agent/build.mjs` 生成，保留依赖许可 |

第三方图形、字体和模型权重不因位于本仓库而自动获得项目 MIT 许可。详见[第三方说明](./THIRD_PARTY.md)。

## 应用图标

从仓库根目录执行：

```sh
npm --prefix apps/desktop run tauri -- icon src-tauri/icons/icon.svg --output ../../target/icon-build/default
npm --prefix apps/desktop run tauri -- icon src-tauri/icons/icon.svg --output ../../target/icon-build/linux --png 32 --png 128 --png 256 --png 512
```

命令在 `apps/desktop` 下执行，先输出到忽略的 `target/` 目录。将以下产物复制到 `apps/desktop/src-tauri/icons/`：

| 生成目录 | 需要保留的文件 |
| --- | --- |
| `target/icon-build/default/` | `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.ico`、`icon.icns`，保持文件名 |
| `target/icon-build/linux/` | 四个尺寸的 PNG，分别命名为 `linux-32x32.png`、`linux-128x128.png`、`linux-256x256.png`、`linux-512x512.png` |

正式打包使用 `tauri.conf.json` 引用的 Linux PNG、ICO、ICNS。修改后检查小尺寸可辨识性和各平台文件引用；生成工具额外输出的移动端图标不属于当前桌面资产清单。

## README 截图

截图使用 `apps/desktop/src/demo/` 的内存数据，不连接真实账号。截图规格为 820×558 CSS 像素、浅色主题、Windows 页面布局；可用 2 倍像素密度输出以便阅读。

```sh
npm --prefix apps/desktop run build:demo -- --outDir ../../target/docs-site/product-demo
python -m http.server 1422 --bind 127.0.0.1 --directory target/docs-site
```

浏览器打开以下入口，分别使用 `zh-CN` 和 `en-US`：

```text
http://127.0.0.1:1422/product-demo/demo/index.html?locale=zh-CN&theme=default-light&platform=windows#/
http://127.0.0.1:1422/product-demo/demo/index.html?locale=zh-CN&theme=default-light&platform=windows#/models
http://127.0.0.1:1422/product-demo/demo/index.html?locale=zh-CN&theme=default-light&platform=windows#/providers
```

文件名对应 `overview`、`models`、`accounts` 和语言后缀。保留“演示模式”标识；截图不得包含真实账号、密钥、个人路径、浏览器工具栏或其他应用内容。等图表、字体加载和动画结束后再截取，不通过图片编辑隐藏界面缺陷。

## 发布资产

正式安装包、更新清单与签名由 [.github/workflows/release.yml](../.github/workflows/release.yml) 生成并上传到本仓库 Releases，不提交到 `images/`。

- Windows：NSIS 安装包、便携 ZIP 与签名。
- macOS：Apple Silicon 和 Intel 对应安装资产及更新包。
- Linux：工作流生成的安装包及更新资产。
- 更新清单：`latest.json`、`portable-latest.json`，以及当前仍交付的 `update.json`。

本地调试包位于 `target/`；演示构建、临时截图、私钥和本地数据库不进入版本控制。
