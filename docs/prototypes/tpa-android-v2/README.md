# 安卓截图复现预览

状态：8 个参考画面的浏览器复现。尚未接入 Android 原生端、电脑 TPA 或云端。

本版以用户提供的图片为准，保留布局和文案，不延用第一版自行设计的首页。生产后端和 Android 工程保持暂停，等待界面核对。

## 页面对应

| 参考画面 | 预览参数 | 交互入口 |
| --- | --- | --- |
| 对话首页 | 无 | 默认页面 |
| 工作区弹层 | `?sheet=workspace` | 点击左上角头像 |
| 定时任务列表 | `?screen=tasks` | 点击底部定时任务 |
| 定时任务编辑 | `?screen=task-new` | 点击新建定时任务 |
| 项目列表 | `?screen=projects` | 点击底部项目 |
| 项目内对话 | `?screen=project` | 点击 workbench 项目 |
| 新建对话弹层 | `?screen=project&sheet=new-chat` | 点击右下角写入按钮 |
| 你好会话 | `?screen=chat` | 独立预览入口；返回按钮进入首页 |

尚无参考图的设置、归档、筛选及选择器只提示预览边界，不自行补画。输入框可以编辑，聊天消息可以复制。保存和发送只说明预览状态，不创建真实任务或发送消息。

## 复现范围

- 页面主体由 React 组件重建，复用 TPA 的 Tailwind、shadcn、Lucide 和 LogoMark。
- 手机系统状态栏在浏览器里使用用户原图的顶部区域。原始文件完整复制到 `reference-assets/`，CSS 只显示系统区域，不将页面主体作为图片展示。用户原文件未修改。真实 Android 应用应交给系统显示状态栏。
- 字体优先使用设备已有的 MiSans。Windows 没有该字体时使用系统后备字体，字形与字重仍可能不同。没有下载或再分发 MiSans。
- GitHub 图标使用 [GitHub 官方标志](https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png)，仅用于参考图中的 GitHub 选项。其他应用图标使用 Lucide，部分轮廓与截图仍有差异。
- 系统手势条和表单时间为截图中的静态值。本版不读取手机状态，不进行账号登录。

## 构建与验证

在 TPA 根目录运行：

```powershell
node node_modules/typescript/bin/tsc --noEmit -p docs/prototypes/tpa-android-v2/tsconfig.json
node node_modules/vite/bin/vite.js build --config docs/prototypes/tpa-android-v2/vite.config.mts
node docs/prototypes/tpa-android-v2/verify.mjs
```

输出目录：`E:/A PI/output/TPA/android-reference-v2`。`TPA-reference-preview.html` 可直接打开。验证脚本生成 8 张截图，检查页面跳转、弹层、输入、复制、预览边界、窄屏布局和浏览器错误；不调用模型，不修改服务器。

## 保留的同步需求

正式功能必须同步电脑中同一个 TPA 会话。正文增量、电脑实际收到的思考内容、工具开始／增量输出／结束、等待确认、停止和结果都需要经过用户云端传到手机。双端输入属于同一会话；断线后补齐遗漏事件。现有定时文本快照方案尚不能作为此需求的完成依据。
