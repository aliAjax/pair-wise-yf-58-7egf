/**
 * 实验层放量模拟（npx tsx sim/experiment-sim.ts）
 *
 * 第一幕：旧模式——开关各算各的（冲突实验同时命中 + 名额失控）
 * 第二幕：接进实验层——层容量 / 全局名额 / 层内互斥 / 不同层同人命中 / 满了排队
 * 第三幕：规则改动——旧占位作废重算，已占住先保留，超出按登记先后退出并写明原因
 */
import {
  ExperimentPlatform,
  exitReasonText,
  hashBucket,
  waitReasonText,
  type ExperimentConfig,
  type LayerResult,
  type Placement,
  type RecomputeReport,
  type User
} from '../src/experiment/engine.ts';

/* ---------------- 输出小工具 ---------------- */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
};
const pad = (text: string, width: number): string => {
  const n = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - n));
};
function banner(title: string): void {
  console.log(`\n${C.bold}${C.cyan}━━━━━━━━━━━━━━━━━━━━ ${title} ━━━━━━━━━━━━━━━━━━━━${C.reset}`);
}
function legend(): void {
  console.log(`${C.dim}图例：${C.green}●占住${C.dim}  ${C.yellow}◌排队${C.dim}  ${C.red}✕退出${C.dim}  · 未命中${C.reset}`);
}

/* ---------------- 演示数据 ---------------- */

const USERS: User[] = [
  { id: 'u-1001', name: '王·上海8.4登录', region: '上海', appVersion: '8.4.0', authenticated: true },
  { id: 'u-1002', name: '李·上海8.1游客', region: '上海', appVersion: '8.1.0', authenticated: false },
  { id: 'u-1003', name: '赵·北京8.5登录', region: '北京', appVersion: '8.5.0', authenticated: true },
  { id: 'u-1004', name: '钱·广东8.0登录', region: '广东', appVersion: '8.0.0', authenticated: true },
  { id: 'u-1005', name: '孙·上海8.3游客', region: '上海', appVersion: '8.3.0', authenticated: false },
  { id: 'u-1006', name: '周·上海8.2登录', region: '上海', appVersion: '8.2.0', authenticated: true },
  { id: 'u-1007', name: '吴·北京8.4登录', region: '北京', appVersion: '8.4.0', authenticated: true },
  { id: 'u-1008', name: '郑·上海8.6登录', region: '上海', appVersion: '8.6.0', authenticated: true },
  { id: 'u-1009', name: '冯·广东8.3游客', region: '广东', appVersion: '8.3.0', authenticated: false },
  { id: 'u-1010', name: '陈·上海8.5登录', region: '上海', appVersion: '8.5.0', authenticated: true }
];

const CONFIG_V1: ExperimentConfig = {
  globalCapacity: 8,
  layers: [
    {
      id: 'pay', name: '支付链路层', capacity: 6, salt: 'pay-layer-v1',
      experiments: [
        { id: 'checkout-v2', flagKey: 'checkout-v2', name: '新版结算页', weight: 5, enabled: true, capacity: 3, targeting: { regions: ['上海', '北京'], minVersion: '8.2', requireAuth: true } },
        { id: 'checkout-slim', flagKey: 'checkout-slim', name: '轻量结算(游客)', weight: 5, enabled: true, capacity: 3, targeting: { regions: ['上海', '北京', '广东'], minVersion: '8.0' } }
      ]
    },
    {
      id: 'rec', name: '推荐算法层', capacity: 8, salt: 'rec-layer-v1',
      experiments: [
        { id: 'model-b', flagKey: 'recommend-model-b', name: '推荐模型B', weight: 7, enabled: true, capacity: 6, targeting: {} },
        { id: 'model-c', flagKey: 'recommend-model-c', name: '推荐模型C', weight: 3, enabled: true, targeting: { minVersion: '8.2', requireAuth: true } }
      ]
    },
    {
      id: 'msg', name: '消息样式层', capacity: 3, salt: 'msg-layer-v1',
      experiments: [
        { id: 'msg-v2', flagKey: 'msg-style-v2', name: '消息卡片V2', weight: 10, enabled: true, targeting: { requireAuth: true } }
      ]
    }
  ]
};

/* ---------------- 第一幕：旧模式 ---------------- */

/** 旧版 flags.ts 的独立算桶逻辑：charCode 求和取模，只看自己的 rollout，互不感知 */
function legacyHit(user: User, rollout: number): number {
  const bucket = [...user.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 100;
  return bucket < rollout ? bucket : -1;
}

function actOld(): void {
  banner('第一幕　旧模式：开关各算各的（复现故障）');
  const flags = [
    { key: 'checkout-v2', rollout: 60, layer: '支付链路层' },
    { key: 'checkout-slim', rollout: 60, layer: '支付链路层（互斥对象）' },
    { key: 'recommend-model-b', rollout: 80, layer: '推荐算法层' },
    { key: 'recommend-model-c', rollout: 50, layer: '推荐算法层（互斥对象）' }
  ];
  console.log(`${C.dim}每个开关独立哈希、独立放量，不知道彼此，也没有容量/全局名额概念。${C.reset}\n`);
  console.log(`${pad('用户', 22)} ${flags.map((f) => pad(f.key, 18)).join(' ')} 问题`);
  let conflictUsers = 0;
  for (const user of USERS) {
    const cells = flags.map((f) => {
      const bucket = legacyHit(user, f.rollout);
      return { text: bucket >= 0 ? `${C.green}命中 桶${String(bucket).padStart(2)}${C.reset}${C.dim}` : `${C.dim}未命中${C.dim}`, hit: bucket >= 0 };
    });
    const payConflict = cells[0].hit && cells[1].hit;
    const recConflict = cells[2].hit && cells[3].hit;
    const problems: string[] = [];
    if (payConflict) problems.push('支付层两实验互斥却同时落中');
    if (recConflict) problems.push('推荐层两实验互斥却同时落中');
    if (payConflict || recConflict) conflictUsers += 1;
    console.log(
      `${pad(`${user.id} ${user.name ?? ''}`, 22)} ${cells.map((c) => pad(c.text, 28)).join(' ')} ${C.red}${problems.join('；') || ''}${C.reset}`
    );
  }
  // 名额失控：无上限放量，“名额”只随 rollout 膨胀
  const admitCount = USERS.map((u) => flags.filter((f) => legacyHit(u, f.rollout) >= 0).length);
  console.log(`\n${C.red}${C.bold}→ ${conflictUsers} 个用户落进同层互斥实验；4 个开关的“放量名额”合计可到 ${flags.reduce((s, f) => s + f.rollout, 0)}% 份，没有任何一层/全局容量卡点。${C.reset}`);
  console.log(`${C.dim}占位次数（同人可被重复计数）：${admitCount.reduce((a, b) => a + b, 0)} 次 / 仅 ${USERS.length} 个用户。${C.reset}`);
}

/* ---------------- 第二幕：接进实验层 ---------------- */

function stateIcon(state: Placement['state'] | 'miss'): string {
  switch (state) {
    case 'occupying': return `${C.green}●占住${C.reset}`;
    case 'queued': return `${C.yellow}◌排队${C.reset}`;
    case 'exited': return `${C.red}✕退出${C.reset}`;
    default: return `${C.dim}· 未中${C.reset}`;
  }
}

function expName(platform: ExperimentPlatform, layerId: string, experimentId: string | null): string {
  if (!experimentId) return '—';
  return platform.experimentById(layerId, experimentId)?.name ?? experimentId;
}

function printCapacity(platform: ExperimentPlatform): void {
  const layers = platform.config.layers.map((layer) => {
    const occ = platform.layerOccupied(layer.id);
    const overflow = occ > layer.capacity;
    return `${layer.name} ${C.bold}${occ}/${layer.capacity}${C.reset}${overflow ? C.red : ''}${overflow ? ' 超限!' : ''}${C.reset}`;
  });
  const g = platform.globalOccupied();
  console.log(
    `容量：${layers.join('　')}　全局(去重用户) ${C.bold}${g}/${platform.config.globalCapacity}${C.reset}${g > platform.config.globalCapacity ? `${C.red} 超限!${C.reset}` : ''}`
  );
}

function printUserMatrix(platform: ExperimentPlatform, title: string): void {
  console.log(`\n${C.bold}${title}${C.reset}`);
  legend();
  const layerCols = platform.config.layers;
  const header = `${pad('用户(登记号)', 26)} ${layerCols.map((l) => pad(l.name, 30)).join(' ')}`;
  console.log(header);
  for (const user of platform.allUsers()) {
    const cells = layerCols.map((layer) => {
      const p = platform.placement(user.id, layer.id);
      const exp = p?.experimentId ? expName(platform, layer.id, p.experimentId) : null;
      let line: string;
      if (p?.state === 'occupying') {
        line = `${C.green}● ${exp} [桶${p.bucket}]${C.reset}${C.dim}`;
      } else if (p?.state === 'queued') {
        line = `${C.yellow}◌ 排队等「${exp}」${C.reset}${C.dim}`;
      } else if (p?.state === 'exited') {
        line = `${C.red}✕ 退出${C.reset}${C.dim}`;
      } else {
        const bucket = hashBucket(layer.salt, user.id);
        line = `· 未命中 [桶${bucket}]`;
      }
      return pad(line + C.reset, 40);
    });
    console.log(`${pad(`#${user.admitSeq} ${user.id} ${user.name ?? ''}`, 26)} ${cells.join(' ')}`);
  }
}

function printLayerDetails(platform: ExperimentPlatform): void {
  for (const layer of platform.config.layers) {
    console.log(`\n${C.bold}【${layer.name}】容量 ${layer.capacity}${C.reset}`);
    for (const exp of layer.experiments) {
      const occ = platform.experimentOccupied(layer.id, exp.id);
      const cap = exp.capacity === undefined ? '不限' : `${occ}/${exp.capacity}`;
      const state = exp.enabled ? `${C.green}开关ON${C.reset}` : `${C.red}开关OFF${C.reset}`;
      console.log(
        `  ${state} ${pad(exp.name, 14)} 权重${exp.weight} 名额${pad(cap, 8)} 定向: ` +
        `${exp.targeting.regions?.join('/') ?? '不限地区'} · ≥${exp.targeting.minVersion ?? '不限'} · ${exp.targeting.requireAuth ? '需登录' : '不要求登录'}`
      );
    }
    const q = platform.queue(layer.id);
    if (q.length) {
      console.log(`  ${C.yellow}排队队列（按登记先后，名额空出即按此顺序递补）：${C.reset}`);
      for (const p of q) {
        console.log(`    #${p.admitSeq} ${p.userId} → 「${expName(platform, layer.id, p.experimentId)}」桶${p.bucket}，原因：${p.waitReason ? waitReasonText(p.waitReason) : ''}（${p.detail}）`);
      }
    }
  }
}

function actV1(): ExperimentPlatform {
  banner('第二幕　接入实验层：容量 + 互斥 + 排队（规则版本 v1）');
  const platform = new ExperimentPlatform(CONFIG_V1);
  console.log(`${C.dim}用户按 u-1001 → u-1010 的顺序依次登记，每人对全部层做稳定哈希分桶；层内至多命中一个实验。${C.reset}\n`);
  for (const user of USERS) {
    const results: LayerResult[] = platform.admit(user);
    const parts = results.map((r) => {
      const layer = platform.layerById(r.layerId)!;
      if (r.state === 'occupying') return `${layer.name}→${C.green}${expName(platform, r.layerId, r.experimentId)}${C.reset}`;
      if (r.state === 'queued') return `${layer.name}→${C.yellow}排队(${r.reason ? waitReasonText(r.reason) : ''})${C.reset}`;
      return `${layer.name}→${C.dim}未中(${r.detail ?? r.reason})${C.reset}`;
    });
    console.log(`#${platform.userById(user.id)!.admitSeq} ${pad(user.id, 8)} ${parts.join('　|　')}`);
  }
  printCapacity(platform);
  printLayerDetails(platform);
  printUserMatrix(platform, '用户 × 层 命中总览（含命中的层、实验、桶号 / 排队 / 未命中原因）');

  // 不变量自检
  const invariants = checkInvariants(platform);
  console.log(`\n${C.bold}不变量自检：${C.reset}` + (invariants.length === 0 ? `${C.green}全部通过${C.reset}（无同层互斥冲突、层/实验/全局名额均未超）` : invariants.map((i) => `${C.red}${i}${C.reset}`).join('；')));
  return platform;
}

/* ---------------- 第三幕：规则改动重算 ---------------- */

const CONFIG_V2: ExperimentConfig = {
  globalCapacity: 6, // 全局名额 8 → 6
  layers: [
    {
      id: 'pay', name: '支付链路层', capacity: 1, salt: 'pay-layer-v1', // 层容量 6 → 1
      experiments: [
        // 定向收紧：只投上海、版本 ≥ 8.5（北京用户与 8.5 以下用户退出）
        { id: 'checkout-v2', flagKey: 'checkout-v2', name: '新版结算页', weight: 5, enabled: true, capacity: 3, targeting: { regions: ['上海'], minVersion: '8.5', requireAuth: true } },
        // 轻量结算开关被关闭：流量重分给同层其他实验
        { id: 'checkout-slim', flagKey: 'checkout-slim', name: '轻量结算(游客)', weight: 5, enabled: false, capacity: 3, targeting: { regions: ['上海', '北京', '广东'], minVersion: '8.0' } },
        // 新开关接入同层，权重 3
        { id: 'checkout-v3', flagKey: 'checkout-v3', name: '极简结算(新)', weight: 3, enabled: true, targeting: { minVersion: '8.0' } }
      ]
    },
    {
      id: 'rec', name: '推荐算法层', capacity: 8, salt: 'rec-layer-v1',
      experiments: [
        { id: 'model-b', flagKey: 'recommend-model-b', name: '推荐模型B', weight: 7, enabled: true, capacity: 6, targeting: {} },
        { id: 'model-c', flagKey: 'recommend-model-c', name: '推荐模型C', weight: 3, enabled: true, targeting: { minVersion: '8.2', requireAuth: true } }
      ]
    },
    // 消息样式开关整体关闭 → 层内无启用实验
    {
      id: 'msg', name: '消息样式层', capacity: 3, salt: 'msg-layer-v1',
      experiments: [
        { id: 'msg-v2', flagKey: 'msg-style-v2', name: '消息卡片V2', weight: 10, enabled: false, targeting: { requireAuth: true } }
      ]
    },
    // 新层接入
    {
      id: 'push', name: '推送触达层(新)', capacity: 8, salt: 'push-layer-v1',
      experiments: [
        { id: 'push-v1', flagKey: 'push-timing-v1', name: '智能推送', weight: 10, enabled: true, targeting: { requireAuth: true } }
      ]
    }
  ]
};

/** 第四幕配置：仅放开名额（定向/开关/权重都不动），看排队者按登记先后递补 */
function configV3(from: ExperimentConfig): ExperimentConfig {
  const next = structuredClone(from);
  next.globalCapacity = 12;
  for (const layer of next.layers) {
    if (layer.id === 'pay') layer.capacity = 6;
    if (layer.id === 'push') layer.capacity = 10;
    for (const exp of layer.experiments) {
      if (exp.id === 'model-b') exp.capacity = 12;
    }
  }
  return next;
}

function renderPlacement(platform: ExperimentPlatform, p: Placement): string {
  return `${p.userId} @ ${platform.layerById(p.layerId)?.name ?? p.layerId} → 「${expName(platform, p.layerId, p.experimentId)}」`;
}

function actV2(platform: ExperimentPlatform): void {
  banner('第三幕　规则改动 v1 → v2：旧占位全部作废，按登记先后重算');
  const changes = [
    '支付链路层容量 6 → 1',
    '全局名额 8 → 6（按去重用户）',
    '「轻量结算(游客)」开关关闭，同层流量重分',
    '「新版结算页」定向收紧为上海且 ≥8.5',
    '同层接入新开关「极简结算」(权重3)',
    '「消息卡片V2」开关关闭（层内无启用实验）',
    '新增「推送触达层」，容量 8，仅登录用户'
  ];
  changes.forEach((c, i) => console.log(`${C.dim}${i + 1}. ${c}${C.reset}`));

  const report: RecomputeReport = platform.changeRules(
    CONFIG_V2,
    '支付层缩容+全局缩容+轻量/消息关开关+收紧结算定向+新增极简结算与推送层',
    '产品负责人'
  );

  console.log(`\n${C.bold}重算报告（规则版本 v${report.version}，${report.at}）${C.reset}`);
  const showList = (label: string, list: Placement[], colorize: (s: string) => string): void => {
    console.log(`\n${colorize(C.bold + label + `（${list.length}）` + C.reset)}`);
    list.forEach((p) => console.log(`  #${p.admitSeq} ${renderPlacement(platform, p)}`));
  };
  showList('① 已占住·原实验保留', report.retained, (s) => s);
  console.log(`\n${C.bold}② 已占住·改投实验（${report.moved.length}）${C.reset}`);
  report.moved.forEach((m) =>
    console.log(`  #${m.placement.admitSeq} ${m.placement.userId} @ ${platform.layerById(m.placement.layerId)?.name}：「${expName(platform, m.placement.layerId, m.fromExperimentId)}」→${C.magenta}「${expName(platform, m.placement.layerId, m.toExperimentId)}」${C.reset}`));
  showList('③ 排队递补为占住', report.promoted, (s) => C.green + s + C.reset);
  showList('④ 此前未命中/新层·新占住', report.newOccupying, (s) => C.green + s + C.reset);
  showList('⑤ 仍在排队', report.queued, (s) => C.yellow + s + C.reset);
  report.queued.forEach((p) =>
    console.log(`    原因：${p.waitReason ? waitReasonText(p.waitReason) : ''}（${p.detail}）`));

  console.log(`\n${C.red}${C.bold}⑥ 退出名单（${report.exited.length}，严格按登记先后排序，逐条写明原因）${C.reset}`);
  for (const item of report.exited) {
    console.log(`  #${item.placement.admitSeq} ${item.placement.userId} @ ${platform.layerById(item.placement.layerId)?.name ?? item.placement.layerId}`);
    console.log(`      ${C.red}${exitReasonText(item.reason)}${C.reset}  ${C.dim}${item.detail}${C.reset}`);
  }

  printCapacity(platform);
  printLayerDetails(platform);
  printUserMatrix(platform, '重算后 用户 × 层 命中总览');

  const invariants = checkInvariants(platform);
  console.log(`\n${C.bold}不变量自检：${C.reset}` + (invariants.length === 0 ? `${C.green}全部通过${C.reset}` : invariants.map((i) => `${C.red}${i}${C.reset}`).join('；')));

  console.log(`\n${C.bold}审计留痕（最近 6 条）：${C.reset}`);
  platform.audit.slice(0, 6).reverse().forEach((a) =>
    console.log(`${C.dim}${a.at}${C.reset} ${a.actor} ${a.action}：${a.detail}`));
}

/* ---------------- 第四幕：放开名额，排队递补 ---------------- */

function actV3(platform: ExperimentPlatform): void {
  banner('第四幕　仅放开名额（v2 → v3）：排队者按登记先后递补');
  const changes = ['支付层容量 1 → 6', '推送层容量 8 → 10', '推荐模型B 实验名额 6 → 12', '全局名额 6 → 12'];
  changes.forEach((c, i) => console.log(`${C.dim}${i + 1}. ${c}（定向、开关、权重均不变）${C.reset}`));

  const before = new Map(platform.queue().map((p) => [`${p.userId}::${p.layerId}`, p]));
  const report = platform.changeRules(configV3(platform.config), '名额放开，验证排队按登记先后递补', '值班人员');

  console.log(`\n${C.bold}重算报告（规则版本 v${report.version}）${C.reset}`);
  const promoted = report.promoted.filter((p) => before.has(`${p.userId}::${p.layerId}`));
  console.log(`\n${C.green}${C.bold}排队递补（${promoted.length}，严格按登记号升序）：${C.reset}`);
  let prevSeq = 0;
  let ordered = true;
  for (const p of promoted) {
    if (p.admitSeq < prevSeq) ordered = false;
    prevSeq = p.admitSeq;
    console.log(`  #${p.admitSeq} ${renderPlacement(platform, p)}`);
  }
  console.log(`${C.dim}递补顺序符合登记先后：${ordered ? C.green + '是' + C.reset : C.red + '否' + C.reset}${C.reset}`);
  if (report.moved.length) {
    console.log(`\n改投（${report.moved.length}）：`);
    report.moved.forEach((m) =>
      console.log(`  #${m.placement.admitSeq} ${m.placement.userId}：「${expName(platform, m.placement.layerId, m.fromExperimentId)}」→「${expName(platform, m.placement.layerId, m.toExperimentId)}」`));
  }
  if (report.exited.length) {
    console.log(`\n退出（${report.exited.length}）：`);
    report.exited.forEach((item) =>
      console.log(`  #${item.placement.admitSeq} ${item.placement.userId}：${exitReasonText(item.reason)}`));
  } else {
    console.log(`\n退出 0：只放开名额不会驱逐任何人。`);
  }
  if (report.queued.length) {
    console.log(`\n${C.yellow}${C.bold}仍在排队（${report.queued.length}）：${C.reset}`);
    report.queued.forEach((p) => console.log(`  #${p.admitSeq} ${renderPlacement(platform, p)}`));
  } else {
    console.log(`\n排队队列为空。`);
  }
  printCapacity(platform);
  printUserMatrix(platform, '放量后 用户 × 层 命中总览');
  const invariants = checkInvariants(platform);
  console.log(`\n${C.bold}不变量自检：${C.reset}` + (invariants.length === 0 ? `${C.green}全部通过${C.reset}` : invariants.map((i) => `${C.red}${i}${C.reset}`).join('；')));
}

/* ---------------- 不变量自检 ---------------- */

function checkInvariants(platform: ExperimentPlatform): string[] {
  const errors: string[] = [];
  for (const layer of platform.config.layers) {
    // 同层互斥：每人在该层至多一个占位对象
    const byUser = new Map<string, Placement[]>();
    platform.allPlacements().filter((p) => p.layerId === layer.id && p.state === 'occupying').forEach((p) => {
      byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
    });
    for (const [userId, list] of byUser) {
      if (new Set(list.map((p) => p.experimentId)).size > 1) errors.push(`${userId} 在 ${layer.name} 同时占住多个实验`);
    }
    if (platform.layerOccupied(layer.id) > layer.capacity) errors.push(`${layer.name} 占位超出容量`);
    for (const exp of layer.experiments) {
      if (exp.capacity !== undefined && platform.experimentOccupied(layer.id, exp.id) > exp.capacity) {
        errors.push(`实验 ${exp.name} 占位超出自身名额`);
      }
    }
  }
  if (platform.globalOccupied() > platform.config.globalCapacity) errors.push('全局去重名额超出');
  // 队列有序
  const q = platform.queue();
  for (let i = 1; i < q.length; i++) {
    if (q[i].admitSeq < q[i - 1].admitSeq) {
      errors.push('排队顺序违反登记先后');
      break;
    }
  }
  return errors;
}

/* ---------------- 运行 ---------------- */

console.log(`${C.bold}实验层放量模拟　${new Date().toLocaleString('zh-CN', { hour12: false })}${C.reset}`);
actOld();
const p = actV1();
actV2(p);
actV3(p);
console.log('');
