# 第三方来源：Claude Quickstarts（CUA 截图几何与轨迹引用）

PiDeck 的 CUA 改进（C0–C2）阅读并参考了 Anthropic 官方仓库 Claude Quickstarts 的电脑操作实现。
本文件登记实际阅读范围、采用方式与未采用部分，便于后续审查来源与许可证边界。

## 来源

- 仓库：`https://github.com/anthropics/claude-quickstarts`
- 固定提交：`9ec32b91df50b0d4906cae64b13c6298055ff40d`
- 本地副本：`E:\IDM下载常规\claude-quickstarts-main\claude-quickstarts-main`（与固定提交逐个比对文本一致）
- 许可证：MIT，Copyright (c) 2023 Anthropic

## 阅读范围

| 文件 | 读到的内容 | 在 PiDeck 的采用方式 |
| --- | --- | --- |
| `computer-use-best-practices/computer_use/image.py` | `target_image_size` 的令牌/长边双约束、编码后尺寸回传 | 未照搬。PiDeck 面向多供应商，不复制固定 Claude 图像预算；以实际交付 JPEG 尺寸作为几何来源 |
| `computer-use-best-practices/computer_use/tools/computer.py` | 图像坐标 → 逻辑坐标换算、`zoom` 的裁剪区域语义与「后续坐标仍指整图」提示 | 改写为 TypeScript 纯函数（`CuaGeometry`）。差异：PiDeck 用 `frameId` 引用具体截图与屏幕物理矩形，不共享「最近一张图」的隐式状态；zoom 产出子帧几何，允许直接点击局部图 |
| `computer-use-best-practices/computer_use/trajectory.py` | 图片单独落盘、记录只存路径引用 | 采用同一原则：`CuaFrameStore` 内容寻址落盘，工具结果与轨迹只存 `screenshotRef`，base64 不进新增记录 |
| `computer-use-best-practices/tests/test_image.py` | 尺寸计算与缩放用例 | 仅作参考；PiDeck 的几何测试用 C0 实机数值（2560×1440 / 2560×1600 / 负原点） |
| `browser-use-demo/browser_use_demo/tools/coordinate_scaling.py` | 固定模型分辨率表与比例缩放 | 明确不采用：不猜测供应商内部缩放；只用实际交付图像尺寸 |
| `computer-use-best-practices/computer_use/tools/batch.py` | 批量动作顺序执行、失败即停 | 仅阅读理解，不移植（PiDeck 不加批量执行器） |
| `computer-use-best-practices/computer_use/loop.py` | 模型循环、截图历史裁剪、缓存 | 仅阅读，不移植（模型与上下文由 pi 管理） |

## 未复制的部分

- 未复制任何 Python 源代码文本。坐标换算、裁剪、图片引用都是按 PiDeck 的 Electron/Win32 平台
  重新实现的纯函数与存储适配（`src/main/cua/CuaGeometry.ts`、`CuaScreen.ts`、`CuaFrameStore.ts`）。
- macOS 的 AppleScript / Quartz / 权限流程、pyautogui 输入实现不适用。
- 固定 Claude 图像尺寸表（`coordinate_scaling.py`）不采用：PiDeck 面向多模型，按实际交付图像换算。
- 批量执行器与模型循环不引入，工具选择仍由 pi 完成。

因此本目录不附加 MIT 许可证全文；若后续真的复制来源代码片段，必须在同一变更里补充版权与许可。
