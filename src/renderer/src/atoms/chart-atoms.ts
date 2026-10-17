/**
 * 图表域交互状态（Jotai）。
 *
 * 按 `sessionId + chartId` 建 atom family：分屏/多栏只订本栏的图表，
 * 不订阅全局当前会话，避免多栏串图（AGENTS「多实例按 session 订阅」）。
 *
 * atom 只存**用户覆盖**（Partial）：默认值由 spec 派生（见 initialChartInteraction），
 * 因此历史恢复、实时新增与放大对话框共用同一份状态，而不会互相覆盖默认图形。
 */
import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { ChartInteractionState } from "../../../shared/types/chart";

export type ChartInteractionOverride = Partial<ChartInteractionState>;

/** key 形如 `sessionId::chartId`（见 chartView.chartInteractionKey）。 */
export const chartInteractionOverrideAtomFamily = atomFamily((_key: string) => atom<ChartInteractionOverride | null>(null));
