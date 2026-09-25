import type { ArchiveRecord, ArchiveState, FieldKey, MergeResult, RecordGroup } from '../types';
import { fieldValue, scorePair } from './matching';

/** 深拷贝一条记录，避免快照与外部响应式对象共享数组引用 */
export const cloneRecord = (record: ArchiveRecord): ArchiveRecord => ({
  ...record,
  people: [...record.people],
  places: [...record.places]
});

/** 一次合并的可读摘要，优先使用合并时留存的原始记录快照 */
export const mergeSummary = (state: ArchiveState, merge: MergeResult) =>
  `${merge.leftRecord?.title ?? state.records.find((record) => record.id === merge.leftId)?.title ?? merge.leftId} ↔ ${merge.rightRecord?.title ?? state.records.find((record) => record.id === merge.rightId)?.title ?? merge.rightId}`;

/** 查找某条记录此前已并入的、尚未撤回的合并 */
export const findPriorMerge = (state: ArchiveState, recordId: string) =>
  state.merges.find((merge) => !merge.withdrawnAt && (merge.leftId === recordId || merge.rightId === recordId));

export interface MergeBlockInfo {
  recordTitle: string;
  recordIdentifier: string;
  mergeLabel: string;
  mergedAt: string;
}

/** 收集会阻断合并的记录：已并入任一未撤回合并的一侧 */
export const collectMergeBlocks = (state: ArchiveState, leftId: string, rightId: string): MergeBlockInfo[] =>
  [leftId, rightId]
    .map((recordId) => {
      const prior = findPriorMerge(state, recordId);
      if (!prior) return null;
      const record = state.records.find((item) => item.id === recordId);
      return {
        recordTitle: record?.title ?? prior.leftRecord?.title ?? prior.rightRecord?.title ?? recordId,
        recordIdentifier: record?.identifier ?? (prior.leftId === recordId ? prior.leftRecord?.identifier : prior.rightRecord?.identifier) ?? '',
        mergeLabel: mergeSummary(state, prior),
        mergedAt: prior.mergedAt
      } satisfies MergeBlockInfo;
    })
    .filter((item): item is MergeBlockInfo => item !== null);

export interface MergeOutcome {
  mergeId: string;
  mergedId: string;
  leftId: string;
  rightId: string;
}

/**
 * 执行一次逐字段合并：
 * 生成合并记录、移除两条原始记录、连带拒绝其它涉及匹配，并留存原始记录快照供撤回。
 * 返回 null 表示前提不成立（匹配或记录缺失），重复合并应由调用方先用 collectMergeBlocks 拦下。
 */
export function applyMerge(
  state: ArchiveState,
  matchId: string,
  chosen: Record<FieldKey, RecordGroup | 'combine'>,
  now: string = new Date().toISOString()
): MergeOutcome | null {
  const match = state.matches.find((item) => item.id === matchId);
  if (!match) return null;
  const left = state.records.find((item) => item.id === match.leftId);
  const right = state.records.find((item) => item.id === match.rightId);
  if (!left || !right) return null;

  const values: Partial<Record<FieldKey, string>> = {};
  fieldKeys.forEach((field) => {
    const source = chosen[field];
    values[field] = source === 'combine'
      ? `${fieldValue(left, field)}；${fieldValue(right, field)}`
      : fieldValue(source === 'A' ? left : right, field);
  });

  const merged: ArchiveRecord = {
    ...left,
    ...values,
    people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
    places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
    status: 'merged',
    updatedAt: now
  };

  state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];

  const autoRejectedMatchIds: string[] = [];
  state.matches.forEach((item) => {
    if (item.id === match.id) {
      item.status = 'merged';
      return;
    }
    if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) {
      // 只登记被本次合并改变状态的匹配，撤回时不覆盖用户此前的手动判断
      if (item.status !== 'rejected') autoRejectedMatchIds.push(item.id);
      item.status = 'rejected';
    }
  });

  const mergeId = crypto.randomUUID();
  state.merges.unshift({
    id: mergeId,
    matchId: match.id,
    leftId: left.id,
    rightId: right.id,
    chosen: { ...chosen },
    values,
    mergedAt: now,
    mergedId: merged.id,
    leftRecord: cloneRecord(left),
    rightRecord: cloneRecord(right),
    autoRejectedMatchIds
  });

  return { mergeId, mergedId: merged.id, leftId: left.id, rightId: right.id };
}

export interface WithdrawOutcome {
  merge: MergeResult;
  label: string;
  restoredMatchCount: number;
}

/**
 * 撤回一次合并：移除合并结果，按快照恢复两条原始记录（编号、字段原样），
 * 主匹配与被连带拒绝的匹配退回待复核；合并后重算过匹配时按原配对补回主匹配。
 * 返回 'missing-snapshot' 表示旧合并缺少快照无法撤回，null 表示合并不存在或已撤回。
 */
export function applyWithdraw(
  state: ArchiveState,
  mergeId: string,
  now: string = new Date().toISOString()
): WithdrawOutcome | 'missing-snapshot' | null {
  const merge = state.merges.find((item) => item.id === mergeId);
  if (!merge || merge.withdrawnAt) return null;
  if (!merge.leftRecord || !merge.rightRecord) return 'missing-snapshot';

  const label = mergeSummary(state, merge);
  const mergedId = merge.mergedId ?? merge.leftId;
  const restoredLeft: ArchiveRecord = { ...cloneRecord(merge.leftRecord), status: 'unreviewed', updatedAt: now };
  const restoredRight: ArchiveRecord = { ...cloneRecord(merge.rightRecord), status: 'unreviewed', updatedAt: now };

  state.records = [
    ...state.records.filter((record) => record.id !== mergedId && record.id !== merge.leftId && record.id !== merge.rightId),
    restoredLeft,
    restoredRight
  ];

  let restoredMatchCount = 0;
  state.matches.forEach((item) => {
    if (item.id === merge.matchId) {
      item.status = 'suggested';
      item.reviewedAt = undefined;
      restoredMatchCount += 1;
    } else if (merge.autoRejectedMatchIds?.includes(item.id) && item.status === 'rejected') {
      item.status = 'suggested';
      item.reviewedAt = undefined;
      restoredMatchCount += 1;
    }
  });

  // 合并后若重新计算过匹配（如导入新记录），主匹配可能已不存在，按原配对补回
  if (!state.matches.some((item) => item.id === merge.matchId)) {
    const scored = scorePair(restoredLeft, restoredRight);
    state.matches = [
      ...state.matches,
      {
        id: merge.matchId,
        leftId: merge.leftId,
        rightId: merge.rightId,
        score: scored.score,
        fieldScores: scored.fieldScores,
        status: 'suggested',
        reasons: scored.reasons
      }
    ];
    restoredMatchCount += 1;
  }

  merge.withdrawnAt = now;
  return { merge, label, restoredMatchCount };
}

const fieldKeys: FieldKey[] = ['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'];
