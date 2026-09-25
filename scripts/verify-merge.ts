import assert from 'node:assert';
import { seedState } from '../src/data/seed.ts';
import { computeMatches } from '../src/utils/matching.ts';
import { applyMerge, applyWithdraw, collectMergeBlocks, findPriorMerge, mergeSummary } from '../src/utils/merge.ts';
import type { ArchiveState } from '../src/types.ts';

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const fresh = (): ArchiveState => seedState();
const cloneState = (state: ArchiveState): ArchiveState => JSON.parse(JSON.stringify(state));
const allA = (): Record<string, 'A'> => ({ title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A' });
const pickAll = (side: 'A' | 'B') => ({ title: side, date: side, people: side, places: side, identifier: side, medium: side, extent: side, rights: side, notes: side } as const);

// seed 中 a-001 ↔ b-001 匹配存在
const findMatch = (state: ArchiveState, leftId: string, rightId: string) =>
  state.matches.find((m) => m.leftId === leftId && m.rightId === rightId);

// 1. 合并基本效果
check('合并后原始记录被移除、生成合并记录、主匹配标记已合并', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  assert.ok(match, 'seed 中应存在 a-001/b-001 匹配');
  const before = state.records.length;
  const outcome = applyMerge(state, match.id, allA(), '2026-09-25T10:00:00.000Z');
  assert.ok(outcome);
  assert.equal(state.records.length, before - 1, '两条并一条，总数 -1');
  assert.ok(!state.records.some((r) => r.id === 'b-001'), '右记录应被移除');
  const mergedRec = state.records.find((r) => r.id === outcome!.mergedId)!;
  assert.equal(mergedRec.status, 'merged');
  assert.equal(state.matches.find((m) => m.id === match.id)!.status, 'merged');
  const merge = state.merges[0];
  assert.equal(merge.leftRecord!.identifier, 'OH-LXZ-2019-01');
  assert.equal(merge.rightRecord!.identifier, 'OH-2019-001');
  assert.equal(merge.leftRecord!.title, '李秀珍口述史访谈');
  assert.equal(merge.rightRecord!.title, '李秀珍女士口述访谈记录');
  assert.deepEqual(merge.leftRecord!.people, ['李秀珍', '周明远'], '快照应保留原始人物数组');
  assert.ok(!merge.withdrawnAt);
});

// 2. 重复合并拦截：同一对再合
check('同一对记录再次合并时被拦截，且讲清先前并到了哪一次', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  applyMerge(state, match.id, allA(), '2026-09-25T10:00:00.000Z');
  const blocks = collectMergeBlocks(state, 'a-001', 'b-001');
  assert.equal(blocks.length, 2, '两侧都已并入，应有两条说明');
  assert.equal(blocks[0].mergeLabel, '李秀珍口述史访谈 ↔ 李秀珍女士口述访谈记录');
  assert.equal(blocks[0].mergedAt, '2026-09-25T10:00:00.000Z');
  assert.ok(blocks.some((b) => b.recordIdentifier === 'OH-LXZ-2019-01'));
  assert.ok(findPriorMerge(state, 'a-001'), 'a-001 应能查到先前合并');
  assert.ok(findPriorMerge(state, 'b-001'));
});

// 3. 重复合并拦截：已并入的记录参加别的配对
check('已合并记录参加另一条匹配时先拦下，并指明先前那一次', () => {
  const state = fresh();
  const match1 = findMatch(state, 'a-001', 'b-001')!;
  // 手工补一条 a-001 ↔ b-003 的跨配对匹配（模拟阈值边缘候选），并在合并时被连带拒绝
  state.matches.push({
    id: 'match-a-001-b-003-extra', leftId: 'a-001', rightId: 'b-003', score: .4,
    fieldScores: state.matches[0].fieldScores, status: 'suggested', reasons: ['组合字段达到匹配阈值']
  });
  applyMerge(state, match1.id, allA(), '2026-09-25T10:00:00.000Z');
  const other = state.matches.find((m) => m.id === 'match-a-001-b-003-extra');
  assert.ok(other && other.status === 'rejected', '跨配对匹配应被连带拒绝');
  const blocks = collectMergeBlocks(state, other!.leftId, other!.rightId);
  assert.equal(blocks.length, 1, '只有 a-001 一侧已并入');
  assert.ok(blocks[0].mergeLabel.includes('李秀珍口述史访谈'));
  assert.equal(blocks[0].recordIdentifier, 'OH-LXZ-2019-01');
});

// 4. 连带拒绝只登记真正改变的匹配；撤回时不误恢复手动忽略
check('撤回只恢复被合并连带拒绝的匹配，不动用户此前手动忽略的匹配', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  // 手工补两条跨配对匹配：一条用户先手动忽略，另一条留给合并连带拒绝
  const extra = (rightId: string, idSuffix: string) => ({
    id: `match-a-001-${rightId}-${idSuffix}`, leftId: 'a-001', rightId, score: .4,
    fieldScores: state.matches[0].fieldScores, status: 'suggested' as const, reasons: ['组合字段达到匹配阈值']
  });
  state.matches.push(extra('b-003', 'manual'), extra('b-005', 'auto'));
  // 用户先手动忽略其中一条
  const manual = state.matches.find((m) => m.id.endsWith('manual'))!;
  manual.status = 'rejected';
  const outcome = applyMerge(state, match.id, allA(), '2026-09-25T10:00:00.000Z')!;
  const merge = state.merges.find((m) => m.id === outcome.mergeId)!;
  assert.ok(!merge.autoRejectedMatchIds!.includes(manual.id), '手动忽略的匹配不应记入连带拒绝');
  assert.ok(merge.autoRejectedMatchIds!.includes('match-a-001-b-005-auto'), '连带拒绝的匹配应被登记');
  applyWithdraw(state, outcome.mergeId, '2026-09-25T11:00:00.000Z');
  assert.equal(manual.status, 'rejected', '手动忽略的匹配撤回后仍应保持忽略');
  // 连带拒绝的应被恢复
  const restored = merge.autoRejectedMatchIds!.map((id) => state.matches.find((m) => m.id === id)!);
  assert.ok(restored.length > 0);
  assert.ok(restored.every((m) => m.status === 'suggested'));
});

// 5. 撤回恢复原始记录（编号+字段），主匹配退回待复核
check('撤回后两条原始记录连同编号与字段回到工作台，主匹配退回待复核', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  const outcome = applyMerge(state, match.id, pickAll('B'), '2026-09-25T10:00:00.000Z')!;
  const withdrawn = applyWithdraw(state, outcome.mergeId, '2026-09-25T11:00:00.000Z');
  assert.notEqual(withdrawn, 'missing-snapshot');
  assert.ok(typeof withdrawn !== 'string');
  const left = state.records.find((r) => r.id === 'a-001')!;
  const right = state.records.find((r) => r.id === 'b-001')!;
  assert.ok(left && right, '两条原始记录都应恢复');
  assert.equal(left.identifier, 'OH-LXZ-2019-01');
  assert.equal(right.identifier, 'OH-2019-001');
  assert.equal(left.title, '李秀珍口述史访谈');
  assert.equal(right.title, '李秀珍女士口述访谈记录');
  assert.deepEqual(right.people, ['李秀珍', '周明远']);
  assert.deepEqual(right.places, ['临河县', '河口村']);
  assert.equal(left.status, 'unreviewed');
  assert.equal(right.status, 'unreviewed');
  // 合并结果记录被移除
  assert.ok(!state.records.some((r) => r.id === outcome.mergedId && r.status === 'merged'), '合并结果记录应被移除');
  // 注意 mergedId === leftId（沿用左 id），恢复后的左记录仍存在
  assert.equal(state.records.find((r) => r.id === 'a-001')!.status, 'unreviewed');
  // 主匹配退回待复核
  assert.equal(state.matches.find((m) => m.id === match.id)!.status, 'suggested');
  assert.equal(state.matches.find((m) => m.id === match.id)!.reviewedAt, undefined);
  // 合并条目标记已撤回
  assert.equal(state.merges.find((m) => m.id === outcome.mergeId)!.withdrawnAt, '2026-09-25T11:00:00.000Z');
});

// 6. 撤回不可重复
check('已撤回的合并不能再次撤回', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  const outcome = applyMerge(state, match.id, allA())!;
  assert.notEqual(applyWithdraw(state, outcome.mergeId), null);
  assert.equal(applyWithdraw(state, outcome.mergeId), null);
  assert.equal(state.records.filter((r) => r.id === 'a-001' || r.id === 'b-001').length, 2, '不能因重复撤回产生重复记录');
});

// 7. 撤回后可重新合并，且不再被拦截
check('撤回后先前拦截解除，可以重新合并', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  const outcome = applyMerge(state, match.id, allA())!;
  assert.ok(collectMergeBlocks(state, 'a-001', 'b-001').length > 0);
  applyWithdraw(state, outcome.mergeId);
  assert.equal(collectMergeBlocks(state, 'a-001', 'b-001').length, 0, '撤回后不应再拦截');
  const outcome2 = applyMerge(state, match.id, pickAll('B'));
  assert.ok(outcome2, '撤回后应能重新合并');
  assert.equal(state.merges[0].chosen.title, 'B', '新合并采用新的字段选择');
});

// 8. 未参与合并的记录不拦截
check('未并入过任何合并的记录可正常合并', () => {
  const state = fresh();
  const match1 = findMatch(state, 'a-001', 'b-001')!;
  applyMerge(state, match1.id, allA());
  const other = findMatch(state, 'a-002', 'b-002');
  assert.ok(other);
  assert.equal(collectMergeBlocks(state, 'a-002', 'b-002').length, 0);
  assert.ok(applyMerge(state, other!.id, allA()));
});

// 9. 撤销/重做随快照生效：撤回后用快照恢复到撤回前
check('撤回与撤销/重做的快照机制兼容', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  const outcome = applyMerge(state, match.id, allA())!;
  const afterMerge = cloneState(state); // 模拟 capture()：撤回前快照
  applyWithdraw(state, outcome.mergeId, '2026-09-25T11:00:00.000Z');
  // 模拟撤销：恢复到撤回前（合并仍生效）
  Object.assign(state, afterMerge, { records: afterMerge.records, matches: afterMerge.matches, merges: afterMerge.merges, audit: afterMerge.audit });
  assert.equal(state.matches.find((m) => m.id === match.id)!.status, 'merged', '撤销撤回后，匹配应回到已合并');
  assert.ok(!state.records.some((r) => r.id === 'b-001'), '撤销撤回后，原右记录不应存在');
  assert.ok(!state.merges.find((m) => m.id === outcome.mergeId)!.withdrawnAt);
  // 模拟重做：再次撤回（逻辑上等同恢复撤回后快照，这里直接重放）
  const redone = applyWithdraw(state, outcome.mergeId, '2026-09-25T11:00:00.000Z');
  assert.ok(redone && redone !== 'missing-snapshot');
  assert.equal(state.matches.find((m) => m.id === match.id)!.status, 'suggested');
});

// 10. 合并后重新计算过匹配（模拟导入），撤回时按原配对补回主匹配
check('合并后匹配被重算丢失时，撤回按原配对补回主匹配', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  const outcome = applyMerge(state, match.id, allA())!;
  // 模拟导入新记录触发 computeMatches：b-001 已不存在，原配对匹配消失
  state.matches = computeMatches(state.records);
  assert.ok(!state.matches.some((m) => m.id === match.id));
  const result = applyWithdraw(state, outcome.mergeId);
  assert.ok(result && result !== 'missing-snapshot');
  const restored = state.matches.find((m) => m.id === match.id);
  assert.ok(restored, '应补回原配对匹配');
  assert.equal(restored!.status, 'suggested');
  assert.equal(restored!.leftId, 'a-001');
  assert.equal(restored!.rightId, 'b-001');
});

// 11. 旧版本合并无快照时不可撤回
check('缺少原始记录快照的旧合并撤回被拒绝', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  const outcome = applyMerge(state, match.id, allA())!;
  const legacy = state.merges.find((m) => m.id === outcome.mergeId)!;
  delete legacy.leftRecord;
  delete legacy.rightRecord;
  assert.equal(applyWithdraw(state, outcome.mergeId), 'missing-snapshot');
  assert.ok(!legacy.withdrawnAt);
});

// 12. 摘要优先使用快照（原记录已不在工作台时仍可显示标题）
check('合并摘要在原始记录被移除后仍来自快照', () => {
  const state = fresh();
  const match = findMatch(state, 'a-001', 'b-001')!;
  const outcome = applyMerge(state, match.id, allA())!;
  const merge = state.merges.find((m) => m.id === outcome.mergeId)!;
  assert.equal(mergeSummary(state, merge), '李秀珍口述史访谈 ↔ 李秀珍女士口述访谈记录');
});

console.log(`\n${passed} 项检查全部通过`);
