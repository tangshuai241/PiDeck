# Android 交互原型

状态：设计验证；所有数据、连接、配对和执行均为本地模拟。没有公网连接、模型调用或 Android 原生功能。

原型复用 TPA 的 Tailwind、主题 token、shadcn Button／Textarea／Dialog 和 Lucide 图标。文案集中在原型 `copy.ts`；正式产品文案应进入对应客户端的完整 i18n 管线。原型未复制 Orca、Paseo 或 T3 Code 源码。

在仓库根目录运行：

```powershell
node node_modules/typescript/bin/tsc --noEmit -p docs/prototypes/tpa-android/tsconfig.json
node node_modules/vite/bin/vite.js build --config docs/prototypes/tpa-android/vite.config.mts --outDir 'E:/A PI/output/TPA/android-remote-v1'
node docs/prototypes/tpa-android/verify.mjs 'E:/A PI/output/TPA/android-remote-v1'
```

检查脚本启动随机端口的本地服务和 Chromium，完成点击后关闭两者。脚本输出截图、`verification.json` 和可直接用浏览器打开的 `TPA-Android-preview.html`。

原型只验证界面操作，不覆盖持久化、真实断网、Android 输入法、后台限制、端到端加密或公网延迟。脚本中的网络开关只切换本地状态。
