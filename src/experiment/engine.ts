/**
 * 实验层引擎
 *
 * 模型：
 * - 开关(flag)挂在层内的实验上，实验带权重与定向规则。
 * - 每个层有容量上限；层内实验互斥：同一用户在同一层至多占住一个实验。
 * - 不同层相互独立，同一用户可以在多个层同时命中。
 * - 全局名额按“去重用户数”卡：一个用户在多个层命中只占 1 个全局名额。
 * - 层满 / 实验满 / 全局满 → 排队（记录排队原因），规则重算时按登记先后递补。
 * - 规则改动(changeRules)后旧占位全部作废重算：已占住者按登记先后优先保留，
 *   保留不下的按登记先后退出并写明原因；排队用户随后按登记序重新尝试。
 */

export interface TargetingRule {
  /** 允许地区；空数组或缺省表示不限制 */
  regions?: string[];
  /** 最低客户端版本，语义化版本号比较 */
  minVersion?: string;
  /** 是否要求已登录 */
  requireAuth?: boolean;
}

export interface ExperimentDef {
  id: string;
  /** 接入的功能开关 key */
  flagKey: string;
  name: string;
  /** 层内流量权重（仅在同层启用实验之间归一化） */
  weight: number;
  /** 开关是否打开，关闭后该实验不参与分桶，流量重分给同层其他实验 */
  enabled: boolean;
  /** 实验自身名额上限，缺省表示不限 */
  capacity?: number;
  targeting: TargetingRule;
}

export interface LayerDef {
  id: string;
  name: string;
  /** 层容量上限（占位数） */
  capacity: number;
  /** 分桶盐值，决定该层的稳定哈希桶 */
  salt: string;
  experiments: ExperimentDef[];
}

export interface ExperimentConfig {
  /** 全局名额：所有层中占住名额的去重用户数上限 */
  globalCapacity: number;
  layers: LayerDef[];
}

export interface User {
  id: string;
  name?: string;
  region: string;
  appVersion: string;
  authenticated: boolean;
}

export type PlacementState = 'occupying' | 'queued' | 'exited';
export type WaitReason = 'experiment_full' | 'layer_full' | 'global_full';
export type ExitReason =
  | WaitReason
  | 'no_enabled_experiment'
  | 'targeting_mismatched'
  | 'layer_removed';
export type MissKind = 'no_enabled_experiment' | 'targeting_mismatched';

export interface Placement {
  userId: string;
  layerId: string;
  /** 命中/排队目标实验；层内无启用实验时为 null */
  experimentId: string | null;
  state: PlacementState;
  /** 登记序号，即全局“登记先后” */
  admitSeq: number;
  /** 稳定哈希桶 0..9999（只取决于层盐 + 用户 id，规则改动不变） */
  bucket: number;
  waitReason?: WaitReason;
  exitReason?: ExitReason;
  detail?: string;
}

export interface LayerResult {
  layerId: string;
  state: PlacementState | 'miss';
  experimentId: string | null;
  bucket: number;
  reason?: WaitReason | MissKind;
  detail?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface RecomputeReport {
  version: number;
  note: string;
  at: string;
  /** 重算后仍占住且实验未变 */
  retained: Placement[];
  /** 仍占住，但改投了别的实验（权重/开关变化导致重分桶） */
  moved: Array<{ placement: Placement; fromExperimentId: string | null; toExperimentId: string }>;
  /** 由排队递补为占住 */
  promoted: Placement[];
  /** 此前未占位（未命中/新层），重算后占住 */
  newOccupying: Placement[];
  /** 仍在排队 */
  queued: Placement[];
  /** 退出（已按登记先后排序） */
  exited: Array<{ placement: Placement; reason: ExitReason; detail: string }>;
}

export interface Snapshot {
  config: ExperimentConfig;
  version: number;
  seq: number;
  users: Array<User & { admitSeq: number }>;
  placements: Placement[];
  audit: AuditEntry[];
}

const BUCKET_SPAN = 10000;

/** FNV-1a 哈希，输出稳定的 0..9999 桶。同一(层, 用户)跨规则版本结果不变。 */
export function hashBucket(salt: string, userId: string): number {
  const input = `${salt}|${userId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % BUCKET_SPAN;
}

export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function waitReasonText(reason: WaitReason): string {
  switch (reason) {
    case 'experiment_full':
      return '实验名额已满';
    case 'layer_full':
      return '层容量已满，排队等名额';
    case 'global_full':
      return '全局名额已满，排队等名额';
  }
}

export function exitReasonText(reason: ExitReason): string {
  switch (reason) {
    case 'experiment_full':
      return '退出：实验名额已满（旧占位重算后保留不下）';
    case 'layer_full':
      return '退出：层容量收缩，按登记先后超出层名额';
    case 'global_full':
      return '退出：全局名额收缩，按登记先后超出全局名额';
    case 'no_enabled_experiment':
      return '退出：层内开关全部关闭，无可投放实验';
    case 'targeting_mismatched':
      return '退出：新定向规则不再匹配该用户';
    case 'layer_removed':
      return '退出：所属实验层已被移除';
  }
}

type Evaluation =
  | { kind: 'eligible'; experiment: ExperimentDef; bucket: number }
  | { kind: 'miss'; reason: MissKind; bucket: number; experimentId: string | null; detail: string };

export class ExperimentPlatform {
  config: ExperimentConfig;
  version = 1;
  private seq = 0;
  private users = new Map<string, User & { admitSeq: number }>();
  private placements = new Map<string, Placement>();
  audit: AuditEntry[] = [];

  constructor(config: ExperimentConfig) {
    this.config = structuredClone(config);
  }

  // ---- 基础查询 ----------------------------------------------------------------

  layerById(layerId: string): LayerDef | undefined {
    return this.config.layers.find((layer) => layer.id === layerId);
  }

  experimentById(layerId: string, experimentId: string): ExperimentDef | undefined {
    return this.layerById(layerId)?.experiments.find((exp) => exp.id === experimentId);
  }

  userById(userId: string): (User & { admitSeq: number }) | undefined {
    return this.users.get(userId);
  }

  allUsers(): Array<User & { admitSeq: number }> {
    return [...this.users.values()].sort((a, b) => a.admitSeq - b.admitSeq);
  }

  placement(userId: string, layerId: string): Placement | undefined {
    return this.placements.get(this.key(userId, layerId));
  }

  allPlacements(): Placement[] {
    return [...this.placements.values()];
  }

  occupants(layerId?: string): Placement[] {
    return this.allPlacements()
      .filter((p) => p.state === 'occupying' && (layerId === undefined || p.layerId === layerId))
      .sort((a, b) => a.admitSeq - b.admitSeq);
  }

  queue(layerId?: string): Placement[] {
    return this.allPlacements()
      .filter((p) => p.state === 'queued' && (layerId === undefined || p.layerId === layerId))
      .sort((a, b) => a.admitSeq - b.admitSeq);
  }

  layerOccupied(layerId: string): number {
    return this.occupants(layerId).length;
  }

  experimentOccupied(layerId: string, experimentId: string): number {
    return this.occupants(layerId).filter((p) => p.experimentId === experimentId).length;
  }

  /** 全局占住名额 = 去重用户数（同一人在多层命中只算 1） */
  globalOccupied(): number {
    return new Set(this.occupants().map((p) => p.userId)).size;
  }

  /** 用户在各层的命中明细 */
  userHits(userId: string): Array<{
    layer: LayerDef;
    state: PlacementState | 'miss';
    experiment: ExperimentDef | null;
    reason?: string;
    detail?: string;
  }> {
    return this.config.layers.map((layer) => {
      const p = this.placement(userId, layer.id);
      const experiment = p?.experimentId ? this.experimentById(layer.id, p.experimentId) ?? null : null;
      const reason = p?.state === 'queued' && p.waitReason ? waitReasonText(p.waitReason)
        : p?.state === 'exited' && p.exitReason ? exitReasonText(p.exitReason) : undefined;
      return {
        layer,
        state: p?.state ?? 'miss',
        experiment,
        reason,
        detail: p?.detail
      };
    });
  }

  // ---- 用户登记 ----------------------------------------------------------------

  /**
   * 用户按调用顺序登记（admitSeq 即登记先后），对每个层独立判定。
   * 同一用户重复登记幂等，返回当前各层结果。
   */
  admit(user: User): LayerResult[] {
    let record = this.users.get(user.id);
    if (!record) {
      this.seq += 1;
      record = { ...user, admitSeq: this.seq };
      this.users.set(user.id, record);
    }
    const results: LayerResult[] = [];
    for (const layer of this.config.layers) {
      const existing = this.placement(user.id, layer.id);
      if (existing) {
        results.push(this.toResult(existing));
        continue;
      }
      const ev = this.evaluate(layer, user);
      if (ev.kind === 'miss') {
        results.push({ layerId: layer.id, state: 'miss', experimentId: ev.experimentId, bucket: ev.bucket, reason: ev.reason, detail: ev.detail });
        continue;
      }
      const acquired = this.tryAcquire(user.id, layer.id, ev.experiment);
      const placement: Placement = {
        userId: user.id,
        layerId: layer.id,
        experimentId: ev.experiment.id,
        state: acquired.ok ? 'occupying' : 'queued',
        admitSeq: record.admitSeq,
        bucket: ev.bucket,
        ...(acquired.ok ? {} : { waitReason: acquired.reason, detail: acquired.detail })
      };
      this.placements.set(this.key(user.id, layer.id), placement);
      results.push(this.toResult(placement));
    }
    this.log('用户登记', `${user.id} 完成各层判定`);
    return results;
  }

  // ---- 规则改动：旧占位作废重算 -------------------------------------------------

  changeRules(next: ExperimentConfig, note: string, actor = '当前操作人'): RecomputeReport {
    const oldConfig = this.config;
    const oldPlacements = new Map(this.placements);
    this.config = structuredClone(next);
    this.version += 1;
    this.placements.clear();

    const retained: RecomputeReport['retained'] = [];
    const moved: RecomputeReport['moved'] = [];
    const promoted: RecomputeReport['promoted'] = [];
    const newOccupying: RecomputeReport['newOccupying'] = [];
    const queued: Placement[] = [];
    const exited: RecomputeReport['exited'] = [];

    const oldOccupants = [...oldPlacements.values()]
      .filter((p) => p.state === 'occupying')
      .sort((a, b) => a.admitSeq - b.admitSeq);

    // 第一批：已占住者按登记先后优先保留
    for (const old of oldOccupants) {
      const user = this.users.get(old.userId)!;
      const layer = this.config.layers.find((item) => item.id === old.layerId);
      if (!layer) {
        this.putExited(old, old.experimentId, 'layer_removed', '实验层已被移除', exited);
        continue;
      }
      const ev = this.evaluate(layer, user);
      if (ev.kind === 'miss') {
        const reason: ExitReason = ev.reason === 'no_enabled_experiment' ? 'no_enabled_experiment' : 'targeting_mismatched';
        this.putExited(old, ev.experimentId, reason, ev.detail, exited);
        continue;
      }
      const acquired = this.tryAcquire(user.id, layer.id, ev.experiment);
      if (!acquired.ok) {
        const reason = acquired.reason as ExitReason;
        this.putExited(old, ev.experiment.id, reason, `${acquired.detail}；保留名单按登记先后，该用户超出名额`, exited);
        continue;
      }
      const placement: Placement = {
        userId: user.id, layerId: layer.id, experimentId: ev.experiment.id,
        state: 'occupying', admitSeq: old.admitSeq, bucket: ev.bucket
      };
      this.placements.set(this.key(user.id, layer.id), placement);
      if (old.experimentId === ev.experiment.id) retained.push(placement);
      else moved.push({ placement, fromExperimentId: old.experimentId, toExperimentId: ev.experiment.id });
    }

    // 第二批：其余用户（排队中、此前未命中、新层）按登记先后重新尝试
    for (const user of this.allUsers()) {
      for (const layer of this.config.layers) {
        const old = oldPlacements.get(this.key(user.id, layer.id));
        if (old?.state === 'occupying') continue; // 第一批已处理
        const ev = this.evaluate(layer, user);
        if (ev.kind === 'miss') {
          if (old?.state === 'queued') {
            const reason: ExitReason = ev.reason === 'no_enabled_experiment' ? 'no_enabled_experiment' : 'targeting_mismatched';
            this.putExited(old, ev.experimentId, reason, ev.detail, exited);
          }
          continue;
        }
        const acquired = this.tryAcquire(user.id, layer.id, ev.experiment);
        const placement: Placement = {
          userId: user.id, layerId: layer.id, experimentId: ev.experiment.id,
          state: acquired.ok ? 'occupying' : 'queued',
          admitSeq: user.admitSeq, bucket: ev.bucket,
          ...(acquired.ok ? {} : { waitReason: acquired.reason, detail: acquired.detail })
        };
        this.placements.set(this.key(user.id, layer.id), placement);
        if (placement.state === 'occupying') {
          if (old?.state === 'queued') promoted.push(placement);
          else newOccupying.push(placement);
        } else {
          queued.push(placement);
        }
      }
      // 已排队用户所在层被移除
      for (const oldLayer of oldConfig.layers) {
        if (this.config.layers.some((item) => item.id === oldLayer.id)) continue;
        const old = oldPlacements.get(this.key(user.id, oldLayer.id));
        if (old?.state === 'queued') {
          this.putExited(old, old.experimentId, 'layer_removed', '实验层已被移除', exited);
        }
      }
    }

    const report: RecomputeReport = {
      version: this.version,
      note,
      at: new Date().toLocaleString('zh-CN', { hour12: false }),
      retained,
      moved: moved.sort((a, b) => a.placement.admitSeq - b.placement.admitSeq),
      promoted: promoted.sort((a, b) => a.admitSeq - b.admitSeq),
      newOccupying: newOccupying.sort((a, b) => a.admitSeq - b.admitSeq),
      queued: queued.sort((a, b) => a.admitSeq - b.admitSeq),
      exited: exited.sort((a, b) => a.placement.admitSeq - b.placement.admitSeq)
    };
    for (const item of report.exited) {
      this.log('规则重算·退出', `${item.placement.userId} @ ${item.placement.layerId}：${exitReasonText(item.reason)}（${item.detail}）`, actor);
    }
    this.log(
      '规则重算',
      `${note}｜保留 ${retained.length} 改投 ${moved.length} 递补 ${promoted.length} 新占位 ${newOccupying.length} 排队 ${queued.length} 退出 ${exited.length}`,
      actor
    );
    return report;
  }

  // ---- 快照（持久化用） ---------------------------------------------------------

  snapshot(): Snapshot {
    return {
      config: structuredClone(this.config),
      version: this.version,
      seq: this.seq,
      users: this.allUsers().map((user) => ({ ...user })),
      placements: this.allPlacements().map((p) => ({ ...p })),
      audit: structuredClone(this.audit)
    };
  }

  static restore(snap: Snapshot): ExperimentPlatform {
    const platform = new ExperimentPlatform(snap.config);
    platform.version = snap.version;
    platform.seq = snap.seq;
    platform.users = new Map(snap.users.map((user) => [user.id, { ...user }]));
    platform.placements = new Map(snap.placements.map((p) => [platform.key(p.userId, p.layerId), { ...p }]));
    platform.audit = structuredClone(snap.audit);
    return platform;
  }

  // ---- 内部实现 ----------------------------------------------------------------

  private key(userId: string, layerId: string): string {
    return `${userId}::${layerId}`;
  }

  private log(action: string, detail: string, actor = '当前操作人'): void {
    this.audit.unshift({
      id: `ae-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      actor,
      action,
      detail
    });
  }

  private toResult(p: Placement): LayerResult {
    return {
      layerId: p.layerId,
      state: p.state,
      experimentId: p.experimentId,
      bucket: p.bucket,
      reason: p.state === 'queued' ? p.waitReason : p.state === 'exited' ? (p.exitReason as WaitReason | MissKind) : undefined,
      detail: p.detail
    };
  }

  private evaluate(layer: LayerDef, user: User): Evaluation {
    const bucket = hashBucket(layer.salt, user.id);
    const enabled = layer.experiments.filter((exp) => exp.enabled && exp.weight > 0);
    if (enabled.length === 0) {
      return { kind: 'miss', reason: 'no_enabled_experiment', bucket, experimentId: null, detail: '层内开关全部关闭，无可投放实验' };
    }
    const totalWeight = enabled.reduce((sum, exp) => sum + exp.weight, 0);
    let cursor = 0;
    let picked: ExperimentDef | null = null;
    enabled.forEach((exp, index) => {
      const width = index === enabled.length - 1 ? BUCKET_SPAN - cursor : Math.floor((exp.weight / totalWeight) * BUCKET_SPAN);
      cursor += width;
      if (picked === null && bucket < cursor) picked = exp;
    });
    const experiment = picked!;
    const mismatch = this.matchTargeting(experiment.targeting, user);
    if (mismatch) {
      return { kind: 'miss', reason: 'targeting_mismatched', bucket, experimentId: experiment.id, detail: mismatch };
    }
    return { kind: 'eligible', experiment, bucket };
  }

  private matchTargeting(rule: TargetingRule, user: User): string | null {
    if (rule.regions && rule.regions.length > 0 && !rule.regions.includes(user.region)) {
      return `地区不匹配（仅投放 ${rule.regions.join('、')}，用户为${user.region}）`;
    }
    if (rule.minVersion && compareVersion(user.appVersion, rule.minVersion) < 0) {
      return `版本过低（要求 ≥ ${rule.minVersion}，用户为 ${user.appVersion}）`;
    }
    if (rule.requireAuth && !user.authenticated) {
      return '要求已登录用户';
    }
    return null;
  }

  private tryAcquire(
    userId: string,
    layerId: string,
    experiment: ExperimentDef
  ): { ok: true } | { ok: false; reason: WaitReason; detail: string } {
    if (experiment.capacity !== undefined && this.experimentOccupied(layerId, experiment.id) >= experiment.capacity) {
      return { ok: false, reason: 'experiment_full', detail: `实验 ${experiment.name} 名额 ${experiment.capacity} 已满` };
    }
    if (this.layerOccupied(layerId) >= this.layerById(layerId)!.capacity) {
      return { ok: false, reason: 'layer_full', detail: `层 ${this.layerById(layerId)!.name} 名额 ${this.layerById(layerId)!.capacity} 已满` };
    }
    const alreadyGlobal = this.occupants().some((p) => p.userId === userId);
    if (!alreadyGlobal && this.globalOccupied() >= this.config.globalCapacity) {
      return { ok: false, reason: 'global_full', detail: `全局名额 ${this.config.globalCapacity}（去重用户）已满` };
    }
    return { ok: true };
  }

  private putExited(
    old: Placement,
    experimentId: string | null,
    reason: ExitReason,
    detail: string,
    exited: RecomputeReport['exited']
  ): void {
    const placement: Placement = {
      ...old,
      experimentId,
      state: 'exited',
      waitReason: undefined,
      exitReason: reason,
      detail
    };
    this.placements.set(this.key(placement.userId, placement.layerId), placement);
    exited.push({ placement, reason, detail });
  }
}
