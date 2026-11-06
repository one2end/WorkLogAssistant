# 应用图标

## 文件

| 文件 | 用途 |
| --- | --- |
| `icon.svg` | **源文件**，改图标只改这个 |
| `icon.png` | 1024×1024，Linux / macOS / 托盘图标 |
| `icon.ico` | Windows，含 16/24/32/48/64/128/256 七个尺寸 |

`icon.png` 和 `icon.ico` 都是生成产物，不要手改。

## 重新生成

改完 `icon.svg` 后执行：

```bash
npm run icons
```

脚本会启动一个离屏 Electron 窗口，把 SVG 按每个尺寸**重新光栅化**（不是从大图缩放），
然后打包成 ICO。输出会打印各尺寸的实际大小和四角透明度，用来确认生成正常。

## 设计说明

- **图形**：一条心电图波形——前波、主尖峰、回落。对应「记录电脑使用痕迹」这件事本身。
- **容器**：圆角矩形（960×960，圆角 228），蓝紫渐变 `#7CA3FF → #6A87FF → #9C7CFF`，
  叠加左上角高光和自上而下的暗角，避免纯色大色块发闷。
- **描边**：80/1024，缩到 16px 约 1.25px，不会糊成灰块。
- **小尺寸**：16px 下前波会和主尖峰粘连，但整体轮廓仍是「活动曲线」；
  24px 起前波可辨，32px 以上细节完整。

应用内的品牌标记（标题栏左上角）用的是同一个波形的 24×24 版本，
改图标时请同步 `src/components/TitleBar.vue` 里的 `<path>`，坐标按 1024 → 24 等比换算。

## Windows 上图标不生效的三种情况

图标分布在三个地方，各有各的来源，改一处不代表三处都对：

| 位置 | 数据来源 | 什么时候生效 |
| --- | --- | --- |
| 运行中窗口 / 任务栏 | `BrowserWindow({ icon })` + `app.setAppUserModelId` | 重启应用即生效 |
| exe 本体（文件属性、开始菜单、桌面快捷方式） | 构建时写进 exe 的资源 | 重新打包并重装 |
| 托盘 | `build/tray.png` | 重启应用即生效 |

### exe 图标：rcedit 权限问题

`electron-builder` 的 `win.icon` 依赖 rcedit，而 rcedit 来自它下载的 `winCodeSign` 包。
这个包里带 macOS 的 dylib 软链，**没开「开发者模式」的 Windows 上 7z 建不了软链，
整包解压失败，打包会直接报错**（`Cannot create symbolic link ... libcrypto.dylib`）。

`package.json` 里因此保留 `signAndEditExecutable: false` 绕开这一步，代价是 exe 会保留
Electron 默认图标。解决办法是**先给 Electron 模板打一次图标**：

```bash
npm run icon:exe
```

它用 rcedit 把 `build/icon.ico` 写进 `node_modules/electron/dist/electron.exe`，
之后每次打包出来的 exe（包括 NSIS 安装包里的）都自带图标，不需要再跑。

> 注意：`npm install` 重装 Electron 后模板会被还原，需要重新执行一次。
> 如果 `npm run icon:exe` 提示找不到 rcedit，说明本机还没成功解压过 winCodeSign——
> 开启 Windows 开发者模式（设置 → 系统 → 开发者选项 → 开发人员模式）后，
> 把 `signAndEditExecutable` 改回 `true` 正常打包一次即可，rcedit 会被解压到缓存里。

