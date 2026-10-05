import { assign, simulate, recalculate } from './src/platform/experimentPlatform';
import type { PlatformState, FlagLike, UserInfo } from './src/platform/types';

function makeState(globalCapacity = 3): PlatformState {
  return {
    layers: [
      { id: 'L1', name: '结算链路层', capacity: 2, queue: [] },
      { id: 'L2', name: '推荐链路层', capacity: 2, queue: [] }
    ],
    experiments: [
      { id: 'E1', layerId: 'L1', flagId: 'f1', name: 'V2' },
      { id: 'E2', layerId: 'L1', flagId: 'f3', name: 'V3' },
      { id: 'E3', layerId: 'L2', flagId: 'f2', name: '推荐' }
    ],
    assignments: [],
    evictions: [],
    globalCapacity,
    nextSeq: 1,
    users: {}
  };
}

const flags: FlagLike[] = [
  { id: 'f1', name: 'V2', enabled: true, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true } },
  { id: 'f3', name: 'V3', enabled: true, rollout: 50, rules: { region: '全部', appVersion: '>= 8.0', authenticated: true } },
  { id: 'f2', name: '推荐', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false } }
];

const u = (id: string, region: string, appVersion: string, authenticated: boolean): UserInfo => ({ id, region, appVersion, authenticated });

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log('== 层内互斥 ==');
{
  const s = makeState();
  const user = u('u-001', '上海', '8.3.0', true);
  const r1 = assign(s, flags, user, 'E1');
  check('assign E1 ok', r1.ok);
  const r2 = assign(s, flags, user, 'E2');
  check('mutual exclusion blocks E2', !r2.ok && r2.reason.includes('互斥'));
  check('only one assignment in L1', s.assignments.filter((a) => a.layerId === 'L1').length === 1);
}

console.log('== 跨层允许同一人命中 ==');
{
  const s = makeState();
  const user = u('u-006', '上海', '8.3.0', true);
  const r1 = assign(s, flags, user, 'E2');
  check('assign E2 (L1) ok', r1.ok);
  const r2 = assign(s, flags, user, 'E3');
  check('assign E3 (L2) ok - cross layer', r2.ok);
  check('user in both layers', s.assignments.filter((a) => a.userId === 'u-006').length === 2);
}

console.log('== 层容量满了排队 ==');
{
  const s = makeState();
  s.layers[0].capacity = 1;
  assign(s, flags, u('u-001', '上海', '8.3.0', true), 'E1');
  const r = assign(s, flags, u('u-002', '上海', '8.2.0', true), 'E1');
  check('layer full -> queued', r.queued === true);
  check('queue has u-002', s.layers[0].queue.includes('u-002'));
}

console.log('== 全局名额卡住 ==');
{
  const s = makeState(1);
  assign(s, flags, u('u-001', '上海', '8.3.0', true), 'E1');
  const r = assign(s, flags, u('u-004', '上海', '8.1.0', false), 'E3');
  check('global full -> blocked', !r.ok && r.reason.includes('全局名额'));
}

console.log('== 规则改动重算：已占住先保留，超出按登记先后退出 ==');
{
  const s = makeState();
  s.layers[0].capacity = 2;
  assign(s, flags, u('u-001', '上海', '8.3.0', true), 'E1');
  assign(s, flags, u('u-002', '上海', '8.2.0', true), 'E1');
  s.layers[0].capacity = 1;
  const evicted = recalculate(s, flags);
  check('one eviction', evicted.length === 1);
  check('evicted u-002 (latest)', evicted[0].userId === 'u-002');
  check('eviction reason 层容量超限', evicted[0].reason === '层容量超限');
  check('u-001 kept (earliest)', s.assignments.some((a) => a.userId === 'u-001'));
  check('u-002 removed', !s.assignments.some((a) => a.userId === 'u-002'));
}

console.log('== 规则不再命中 -> 退出 ==');
{
  const s = makeState();
  assign(s, flags, u('u-001', '上海', '8.3.0', true), 'E1');
  const newFlags = flags.map((f) => (f.id === 'f1' ? { ...f, rules: { ...f.rules, region: '北京' } } : f));
  const evicted = recalculate(s, newFlags);
  check('evicted for rule mismatch', evicted.length === 1 && evicted[0].reason === '规则不再命中');
}

console.log('== 全局名额超限 -> 退出 ==');
{
  const s = makeState(5);
  s.layers[0].capacity = 5;
  s.layers[1].capacity = 5;
  assign(s, flags, u('u-001', '上海', '8.3.0', true), 'E1');
  assign(s, flags, u('u-002', '上海', '8.2.0', true), 'E1');
  assign(s, flags, u('u-004', '上海', '8.1.0', false), 'E3');
  s.globalCapacity = 2;
  const evicted = recalculate(s, flags);
  check('evicted for global over', evicted.length === 1 && evicted[0].reason === '全局名额超限');
  check('kept earliest two', s.assignments.length === 2);
}

console.log('== 模拟返回命中的层和实验 ==');
{
  const s = makeState();
  const user = u('u-006', '上海', '8.3.0', true);
  const results = simulate(s, flags, user);
  const l1 = results.find((r) => r.layerId === 'L1');
  check('simulate L1 hit', l1?.hit === true);
  check('simulate L1 experiment V3', l1?.experimentName === 'V3');
  const l2 = results.find((r) => r.layerId === 'L2');
  check('simulate L2 hit (cross layer)', l2?.hit === true);
  check('simulate L2 experiment 推荐', l2?.experimentName === '推荐');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
