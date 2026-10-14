/**
 * 工作台材料的目标会话候选（P04）。
 *
 * 数据来源与侧栏同一投影：`sessionIdsByProjectAtom`（顺序）+ `sessionRecordsAtom`（记录）。
 * 只列当前项目的持久会话；匿名/临时会话（`noSession`）不参与——它们随运行时会话消失，
 * 绑定上去会立刻变 stale，属于误导。
 */

import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { sessionIdsByProjectAtom, sessionRecordsAtom } from "../atoms";

export type WorkbenchSessionTarget = {
	id: string;
	title: string;
	projectId: string;
};

export function useWorkbenchSessionTargets(projectId: string | null | undefined): WorkbenchSessionTarget[] {
	const records = useAtomValue(sessionRecordsAtom);
	const idsByProject = useAtomValue(sessionIdsByProjectAtom);
	return useMemo(() => {
		if (!projectId) return [];
		const ids = idsByProject[projectId] ?? [];
		const targets: WorkbenchSessionTarget[] = [];
		for (const id of ids) {
			const record = records[id];
			if (!record || record.noSession === true) continue;
			targets.push({ id: record.id, title: record.title.trim().length > 0 ? record.title : record.id, projectId: record.projectId });
		}
		return targets;
	}, [idsByProject, projectId, records]);
}
