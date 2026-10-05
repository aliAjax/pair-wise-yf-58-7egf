import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExperimentPlatform,
  hashBucket,
  type ExperimentConfig,
  type User
} from '../src/experiment/engine.ts';

const baseConfig: ExperimentConfig = {
  globalCapacity: 3,
  layers: [
    {
      id: 'L', name: '层L', capacity: 3, salt: 'salt-l',
      experiments: [
        { id: 'A', flagKey: 'flag-a', name: '实验A', weight: 5, enabled: true, targeting: {} },
        { id: 'B', flagKey: 'flag-b', name: '实验B', weight: 5, enabled: true, targeting: {} }
      ]
    },
    {
      id: 'M', name: '层M', capacity: 3, salt: 'salt-m',
      experiments: [
        { id: 'C', flagKey: 'flag-c', name: '实验C', weight: 10, enabled: true, targeting: {} }
      ]
    }
  ]
};

const user = (id: string, overrides: Partial<User> = {}): User => ({
  id, region: '上海', appVersion: '8.0.0', authenticated: true, ...overrides
});

test('哈希稳定：同层同人多次计算桶号一致', () => {
  assert.equal(hashBucket('salt-l', 'u1'), hashBucket('salt-l', 'u1'));
  assert.notEqual(hashBucket('salt-l', 'u1'), hashBucket('salt-m', 'u1'));
});

test('层内互斥：一个用户在同一层最多占一个实验', () => {
  const p = new ExperimentPlatform(baseConfig);
  for (let i = 1; i <= 20; i++) p.admit(user(`u${i}`));
  for (const u of p.allUsers()) {
    const occ = p.allPlacements().filter((x) => x.userId === u.id && x.layerId === 'L' && x.state === 'occupying');
    assert.ok(occ.length <= 1);
  }
});

test('层容量：超出进队列且带 layer_full 原因', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 100;
  cfg.layers[0].capacity = 2;
  const p = new ExperimentPlatform(cfg);
  // 找到前 4 个分桶到 L 层的用户
  const bucketed: User[] = [];
  for (let i = 1; i <= 200 && bucketed.length < 4; i++) {
    const u = user(`probe-${i}`);
    // 无条件实验：只要登记就会进层（满之前），先只算桶判断
    bucketed.push(u);
    p.admit(u);
  }
  assert.ok(bucketed.length >= 4);
  assert.equal(p.layerOccupied('L'), 2);
  const q = p.queue('L');
  assert.ok(q.length >= 2);
  for (const item of q) {
    // 先满层后满实验，且实验未设 capacity，所以只能是 layer_full
    assert.equal(item.waitReason, 'layer_full');
  }
  // 队列按登记先后
  const seqs = q.map((x) => x.admitSeq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('实验名额：实验自身 capacity 也会排队', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 100;
  cfg.layers[0].capacity = 100;
  cfg.layers[0].experiments[0].capacity = 1;
  const p = new ExperimentPlatform(cfg);
  // 找到两个都落到实验 A 的用户
  let placed = 0;
  for (let i = 1; i <= 500 && placed < 2; i++) {
    const u = user(`a-${i}`);
    p.admit(u);
    const pl = p.placement(u.id, 'L');
    if (pl?.experimentId === 'A' && pl.state === 'occupying') placed++;
  }
  const aQueue = p.queue('L').filter((x) => x.experimentId === 'A');
  assert.ok(aQueue.length >= 1);
  assert.equal(aQueue[0].waitReason, 'experiment_full');
});

test('全局名额按去重用户：同人多层命中只占 1', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 2;
  cfg.layers[0].capacity = 10;
  cfg.layers[1].capacity = 10;
  const p = new ExperimentPlatform(cfg);
  p.admit(user('g1'));
  p.admit(user('g2'));
  p.admit(user('g3'));
  assert.equal(p.globalOccupied(), 2);
  // g1 在两层都占住，但全局只算 1 人
  assert.equal(p.placement('g1', 'L')?.state, 'occupying');
  assert.equal(p.placement('g1', 'M')?.state, 'occupying');
  // g3 两层都因全局满排队
  assert.equal(p.placement('g3', 'L')?.waitReason, 'global_full');
  assert.equal(p.placement('g3', 'M')?.waitReason, 'global_full');
});

test('定向不匹配不占位', () => {
  const cfg = structuredClone(baseConfig);
  cfg.layers[0].experiments[0].targeting = { regions: ['北京'] };
  cfg.layers[0].experiments[1].targeting = { regions: ['北京'] };
  cfg.layers[1].experiments[0].targeting = { minVersion: '9.0.0' };
  const p = new ExperimentPlatform(cfg);
  p.admit(user('g1', { region: '上海', appVersion: '8.0.0' }));
  assert.equal(p.placement('g1', 'L'), undefined); // 未命中不产生占位记录
  assert.equal(p.layerOccupied('M'), 0);
});

test('开关关闭：该实验不参与分桶，流量全部给同层其他实验', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 100;
  cfg.layers[0].experiments[1].enabled = false;
  const p = new ExperimentPlatform(cfg);
  for (let i = 1; i <= 20; i++) p.admit(user(`off-${i}`));
  const occ = p.occupants('L');
  assert.ok(occ.length > 0);
  assert.ok(occ.every((x) => x.experimentId === 'A'));
});

test('规则重算：已占住者按登记先后保留，超出按登记先后退出', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 100;
  const p = new ExperimentPlatform(cfg);
  const ids = ['r1', 'r2', 'r3', 'r4'];
  ids.forEach((id) => p.admit(user(id)));
  assert.equal(p.layerOccupied('L'), 4 > cfg.layers[0].capacity ? cfg.layers[0].capacity : 4);

  const next = structuredClone(cfg);
  next.layers[0].capacity = 1; // 层缩容到 1
  const report = p.changeRules(next, 'L层缩容到1');
  assert.equal(p.layerOccupied('L'), 1);
  const layerExits = report.exited.filter((e) => e.placement.layerId === 'L');
  const kept = p.occupants('L')[0];
  // 占住的是登记最早的那个
  assert.equal(kept.admitSeq, Math.min(...p.allUsers().filter((u) => {
    const pl = p.placement(u.id, 'L');
    return pl?.state === 'occupying' || layerExits.some((e) => e.placement.userId === u.id);
  }).map((u) => u.admitSeq)));
  // 退出原因 layer_full，且退出名单登记号有序
  assert.ok(layerExits.every((e) => e.reason === 'layer_full'));
  const exitSeqs = layerExits.map((e) => e.placement.admitSeq);
  assert.deepEqual(exitSeqs, [...exitSeqs].sort((a, b) => a - b));
});

test('规则重算：关开关 → 命中该实验者退出 no_enabled_experiment 或重分桶', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 100;
  cfg.layers[1].capacity = 5;
  const p = new ExperimentPlatform(cfg);
  for (let i = 1; i <= 3; i++) p.admit(user(`m${i}`));
  const next = structuredClone(cfg);
  next.layers[1].experiments[0].enabled = false;
  const report = p.changeRules(next, 'M层实验关闭');
  assert.equal(p.layerOccupied('M'), 0);
  assert.ok(report.exited.filter((e) => e.placement.layerId === 'M').every((e) => e.reason === 'no_enabled_experiment'));
});

test('规则重算：定向收紧导致 targeting_mismatched 退出', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 100;
  const p = new ExperimentPlatform(cfg);
  p.admit(user('t1', { region: '上海' }));
  assert.equal(p.placement('t1', 'M')?.state, 'occupying');
  const next = structuredClone(cfg);
  next.layers[1].experiments[0].targeting = { regions: ['北京'] };
  const report = p.changeRules(next, 'M层仅投北京');
  const exit = report.exited.find((e) => e.placement.userId === 't1' && e.placement.layerId === 'M');
  assert.ok(exit);
  assert.equal(exit.reason, 'targeting_mismatched');
  assert.equal(p.placement('t1', 'M')?.state, 'exited');
});

test('规则重算：移除层 → layer_removed 退出', () => {
  const p = new ExperimentPlatform(baseConfig);
  p.admit(user('d1'));
  const next = structuredClone(baseConfig);
  next.layers = next.layers.filter((layer) => layer.id !== 'M');
  const report = p.changeRules(next, '删除M层');
  assert.ok(report.exited.some((e) => e.placement.layerId === 'M' && e.reason === 'layer_removed'));
});

test('名额放开后排队者按登记先后递补', () => {
  const cfg = structuredClone(baseConfig);
  cfg.globalCapacity = 2;
  cfg.layers[0].capacity = 2;
  cfg.layers[1].capacity = 2;
  const p = new ExperimentPlatform(cfg);
  for (let i = 1; i <= 6; i++) p.admit(user(`q${i}`));
  const queuedBefore = p.queue();
  assert.ok(queuedBefore.length > 0);

  const next = structuredClone(cfg);
  next.globalCapacity = 50;
  next.layers.forEach((layer) => { layer.capacity = 50; });
  const report = p.changeRules(next, '全面放开');
  const promotedIds = new Set(report.promoted.map((x) => `${x.userId}::${x.layerId}`));
  for (const q of queuedBefore) {
    // 之前排队且仍命中（无定向变化）的，应全部递补
    assert.ok(promotedIds.has(`${q.userId}::${q.layerId}`), `${q.userId}@${q.layerId} 应递补`);
    assert.equal(p.placement(q.userId, q.layerId)?.state, 'occupying');
  }
  const seqs = report.promoted.map((x) => x.admitSeq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(report.exited.length, 0);
});

test('幂等：同一用户重复登记不重复占位', () => {
  const p = new ExperimentPlatform(baseConfig);
  p.admit(user('i1'));
  p.admit(user('i1'));
  assert.equal(p.allUsers().length, 1);
  assert.equal(p.allPlacements().filter((x) => x.userId === 'i1').length, 2); // L、M 各一条
});

test('快照恢复后状态一致', () => {
  const p = new ExperimentPlatform(baseConfig);
  for (let i = 1; i <= 6; i++) p.admit(user(`s${i}`));
  const restored = ExperimentPlatform.restore(p.snapshot());
  assert.equal(restored.globalOccupied(), p.globalOccupied());
  assert.equal(restored.queue().length, p.queue().length);
  assert.equal(restored.version, p.version);
});
