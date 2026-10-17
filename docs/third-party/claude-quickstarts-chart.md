# 第三方来源：Claude Quickstarts（图表渲染片段）

PiDeck 的对话内交互图表复制了 Anthropic 官方仓库 Claude Quickstarts 的少量图形组合代码。
本文件按 MIT 许可证要求保留版权与许可声明，并登记实际复制范围。

## 来源

- 仓库：`https://github.com/anthropics/claude-quickstarts`
- 固定提交：`9ec32b91df50b0d4906cae64b13c6298055ff40d`
- 文件：`financial-data-analyst/components/ChartRenderer.tsx`
- 许可证：MIT，Copyright (c) 2023 Anthropic（全文见文末）

## 复制的范围

`ChartRenderer.tsx` 中柱状图与折线图的 Recharts 组合结构：

- `BarChartComponent`：`CartesianGrid vertical={false}`、`XAxis tickLine/axisLine={false} tickMargin`、
  `Bar radius`、`ChartTooltip` + `ChartTooltipContent` 的搭配；
- `MultiBarChartComponent`：按 `chartConfig` 键循环出多组 `Bar`；
- `LineChartComponent`：按系列循环出 `Line`，`strokeWidth={2}`、`dot={false}`；
- `AreaChartComponent`：`Area` 的 `fillOpacity` + `stackId` 堆叠写法（PiDeck 仅在 G2 引入）。

## 改写内容

- 数据类型改为 PiDeck 的 `ChartSpec`（有限系列、显式单位、`schemaVersion`），不再使用自由数据键；
- 折线与面积改为线性连接（来源的 `type="natural"` 会造出源数据之外的形状）；
- 缺失值走 `connectNulls={false}` 断线，不补零；
- 配色改用 PiDeck 的 `--color-chart-1..6` 主题 token（亮暗各一套），不照搬来源的 `--chart-N`；
- 提示框改为自带单位与缺失值显示；图例、数据表、放大、复制、导出为 PiDeck 新增；
- 动画跟随系统「减少动态效果」设置，历史图不播放入场动画；
- 类别标签只在超过阈值时截断，长中文类目改用水平柱状图表达。

## 未采用的部分

`components/ui/chart.tsx`（PiDeck 已有更新版本的同类原语）、`app/api/finance/route.ts`
（Next.js 服务与 Anthropic SDK 调用）、`app/finance/page.tsx`（页面级聊天状态）。
数值读取的 `||` 回退、只取第一条 `tool_use`、固定模型图像尺寸表等问题均未带入。

## 许可证全文

```
MIT License

Copyright (c) 2023 Anthropic

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
