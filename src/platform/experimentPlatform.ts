// 实验层平台核心逻辑（纯函数，与框架无关）
// 规则：
// 1. 开关接进实验层，每个实验属于一个层。
// 2. 每层有容量上限，满了排队（FIFO）。
// 3. 层内实验互斥：一个用户在同一层只能进一个实验，占住该层位置。
// 4. 不同层之间允许同一人命中。
// 5. 全局名额也要卡住。
// 6. 规则改动后旧占位作废重算：已占住的先保留，超出的按登记先后退出并写清原因。

import type {
  AssignResult,
  Assignment,
  EvictionRecord,
  Experiment,
  FlagLike,
  Layer,
  PlatformState,
  SimulateLayerResult,
  UserInfo
} from './types';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** 判断用户是否命中开关规则 */
export function matchesRules(user: UserInfo, flag: FlagLike): boolean {
  const rule = flag.rules;
  if (rule.region !== '全部' && rule.region !== user.region) return false;
  if (rule.authenticated && !user.authenticated) return false;
  if (rule.appVersion && rule.appVersion !== '全部') {
    const m = /^>=\s*(.+)$/.exec(rule.appVersion.trim());
    if (m) {
      if (compareVersions(user.appVersion, m[1].trim()) < 0) return false;
    } else if (rule.appVersion.trim() !== user.appVersion) {
      return false;
    }
  }
  return true;
}

/** 灰度桶：按用户 id 哈希取模 */
export function inRollout(user: UserInfo, flag: FlagLike): boolean {
  const hash = [...user.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 100;
  return hash < flag.rollout;
}

function layerCount(state: PlatformState, layerId: string): number {
  return state.assignments.filter((a) => a.layerId === layerId).length;
}

function findExperimentForUser(state: PlatformState, flags: FlagLike[], layer: Layer, user: UserInfo): Experiment | null {
  const exps = state.experiments.filter((e) => e.layerId === layer.id);
  for (const exp of exps) {
    const flag = flags.find((f) => f.id === exp.flagId);
    if (flag && flag.enabled && matchesRules(user, flag) && inRollout(user, flag)) return exp;
  }
  return null;
}

/**
 * 模拟用户命中（不持久化占位，但会登记用户属性供规则改动重算使用）。
 * 返回该用户在每一层的命中情况，包含命中的层和实验。
 */
export function simulate(state: PlatformState, flags: FlagLike[], user: UserInfo): SimulateLayerResult[] {
  state.users[user.id] = user;
  const results: SimulateLayerResult[] = [];
  for (const layer of state.layers) {
    const matched = findExperimentForUser(state, flags, layer, user);
    if (!matched) {
      results.push({ layerId: layer.id, layerName: layer.name, hit: false, reason: '无命中实验' });
      continue;
    }
    // 层内互斥：用户已在该层占位
    const existing = state.assignments.find((a) => a.userId === user.id && a.layerId === layer.id);
    if (existing) {
      const exp = state.experiments.find((e) => e.id === existing.experimentId);
      results.push({
        layerId: layer.id,
        layerName: layer.name,
        hit: true,
        experimentId: existing.experimentId,
        experimentName: exp?.name,
        reason: '已占位'
      });
      continue;
    }
    if (layerCount(state, layer.id) >= layer.capacity) {
      results.push({
        layerId: layer.id,
        layerName: layer.name,
        hit: false,
        experimentId: matched.id,
        experimentName: matched.name,
        reason: '层容量已满，将排队',
        queued: true
      });
      continue;
    }
    if (state.assignments.length >= state.globalCapacity) {
      results.push({
        layerId: layer.id,
        layerName: layer.name,
        hit: false,
        experimentId: matched.id,
        experimentName: matched.name,
        reason: '全局名额已满'
      });
      continue;
    }
    results.push({
      layerId: layer.id,
      layerName: layer.name,
      hit: true,
      experimentId: matched.id,
      experimentName: matched.name,
      reason: '命中'
    });
  }
  return results;
}

/**
 * 尝试把用户安排进某个实验（真正占位）。
 * 处理层内容量、全局名额、层内互斥；层满则排队。
 */
export function assign(state: PlatformState, flags: FlagLike[], user: UserInfo, experimentId: string): AssignResult {
  state.users[user.id] = user;
  const exp = state.experiments.find((e) => e.id === experimentId);
  if (!exp) return { ok: false, reason: '实验不存在' };
  const layer = state.layers.find((l) => l.id === exp.layerId);
  if (!layer) return { ok: false, reason: '实验层不存在' };

  const existing = state.assignments.find((a) => a.userId === user.id && a.layerId === layer.id);
  if (existing) {
    if (existing.experimentId === exp.id) {
      return { ok: true, reason: '已在实验中', assignment: existing };
    }
    return { ok: false, reason: `层内互斥：已在同层实验（${existing.experimentId}）中` };
  }

  const flag = flags.find((f) => f.id === exp.flagId);
  if (!flag || !flag.enabled) return { ok: false, reason: '开关未启用' };
  if (!matchesRules(user, flag)) return { ok: false, reason: '规则不命中' };
  if (!inRollout(user, flag)) return { ok: false, reason: '灰度桶未命中' };

  if (layerCount(state, layer.id) >= layer.capacity) {
    if (!layer.queue.includes(user.id)) layer.queue.push(user.id);
    return { ok: false, reason: '层容量已满，已排队', queued: true };
  }
  if (state.assignments.length >= state.globalCapacity) {
    return { ok: false, reason: '全局名额已满' };
  }

  const assignment: Assignment = { userId: user.id, layerId: layer.id, experimentId: exp.id, registeredAt: state.nextSeq++ };
  state.assignments.push(assignment);
  layer.queue = layer.queue.filter((id) => id !== user.id);
  return { ok: true, reason: '占位成功', assignment };
}

/** 用户主动离开某实验，腾出的名额按 FIFO 补排队 */
export function leave(state: PlatformState, flags: FlagLike[], userId: string, layerId: string): void {
  state.assignments = state.assignments.filter((a) => !(a.userId === userId && a.layerId === layerId));
  promoteFromQueue(state, flags);
}

/** 规则改动后重算：旧占位作废，已占住的先保留，超出的按登记先后退出并写清原因 */
export function recalculate(state: PlatformState, flags: FlagLike[]): EvictionRecord[] {
  const prior = [...state.assignments];
  state.assignments = [];
  const evictions: EvictionRecord[] = [];
  const kept: Assignment[] = [];

  const candidates: { assignment: Assignment; registeredAt: number }[] = [];
  for (const a of prior) {
    const exp = state.experiments.find((e) => e.id === a.experimentId);
    const flag = exp ? flags.find((f) => f.id === exp.flagId) : undefined;
    const user = state.users[a.userId];
    const stillMatches = !!exp && !!flag && flag.enabled && !!user && matchesRules(user, flag) && inRollout(user, flag);
    if (!stillMatches) {
      evictions.push({
        id: `ev-${state.nextSeq++}`,
        at: new Date().toLocaleTimeString(),
        userId: a.userId,
        layerId: a.layerId,
        experimentId: a.experimentId,
        reason: '规则不再命中'
      });
    } else {
      candidates.push({ assignment: a, registeredAt: a.registeredAt });
    }
  }

  // 已占住的先保留：按登记先后（越早越优先）
  candidates.sort((x, y) => x.registeredAt - y.registeredAt);
  for (const c of candidates) {
    const layer = state.layers.find((l) => l.id === c.assignment.layerId);
    const used = kept.filter((k) => k.layerId === c.assignment.layerId).length;
    if (!layer || used >= layer.capacity) {
      evictions.push({
        id: `ev-${state.nextSeq++}`,
        at: new Date().toLocaleTimeString(),
        userId: c.assignment.userId,
        layerId: c.assignment.layerId,
        experimentId: c.assignment.experimentId,
        reason: '层容量超限'
      });
    } else if (kept.length >= state.globalCapacity) {
      evictions.push({
        id: `ev-${state.nextSeq++}`,
        at: new Date().toLocaleTimeString(),
        userId: c.assignment.userId,
        layerId: c.assignment.layerId,
        experimentId: c.assignment.experimentId,
        reason: '全局名额超限'
      });
    } else {
      kept.push(c.assignment);
    }
  }

  state.assignments = kept;
  // 腾出的名额按 FIFO 补排队
  promoteFromQueue(state, flags);
  return evictions;
}

/** 层内有空位时，按 FIFO 把排队用户补进来 */
function promoteFromQueue(state: PlatformState, flags: FlagLike[]): void {
  for (const layer of state.layers) {
    while (layer.queue.length > 0) {
      const userId = layer.queue[0];
      const user = state.users[userId];
      if (!user) {
        layer.queue.shift();
        continue;
      }
      const used = state.assignments.filter((a) => a.layerId === layer.id).length;
      if (used >= layer.capacity || state.assignments.length >= state.globalCapacity) break;
      const exps = state.experiments.filter((e) => e.layerId === layer.id);
      let promoted = false;
      for (const exp of exps) {
        const flag = flags.find((f) => f.id === exp.flagId);
        if (flag && flag.enabled && matchesRules(user, flag) && inRollout(user, flag)) {
          state.assignments.push({ userId, layerId: layer.id, experimentId: exp.id, registeredAt: state.nextSeq++ });
          layer.queue.shift();
          promoted = true;
          break;
        }
      }
      if (!promoted) layer.queue.shift();
    }
  }
}
