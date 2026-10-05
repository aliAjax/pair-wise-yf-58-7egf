import { defineStore } from 'pinia';
import {
  assign as platformAssign,
  leave as platformLeave,
  recalculate as platformRecalculate,
  simulate as platformSimulate
} from '../platform/experimentPlatform';
import type { Assignment, EvictionRecord, Experiment, Layer, PlatformState, SimulateLayerResult, UserInfo } from '../platform/types';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; }
export interface RolloutPlan { id: string; flagId: string; scheduledAt: string; approvals: string[]; version: number; }
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }

interface State {
  flags: FeatureFlag[];
  plans: RolloutPlan[];
  audit: AuditRecord[];
  activeId: string;
  // 实验层平台
  layers: Layer[];
  experiments: Experiment[];
  assignments: Assignment[];
  evictions: EvictionRecord[];
  globalCapacity: number;
  nextSeq: number;
  users: Record<string, UserInfo>;
}

const seedUsers: Record<string, UserInfo> = {
  'u-001': { id: 'u-001', region: '上海', appVersion: '8.3.0', authenticated: true },
  'u-002': { id: 'u-002', region: '上海', appVersion: '8.2.0', authenticated: true },
  'u-003': { id: 'u-003', region: '北京', appVersion: '8.3.0', authenticated: true },
  'u-004': { id: 'u-004', region: '上海', appVersion: '8.1.0', authenticated: false },
  'u-005': { id: 'u-005', region: '广东', appVersion: '8.3.0', authenticated: true },
  'u-006': { id: 'u-006', region: '上海', appVersion: '8.3.0', authenticated: true },
  'u-007': { id: 'u-007', region: '北京', appVersion: '8.0.0', authenticated: true }
};

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页 V2', key: 'checkout-v2', enabled: true, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'rolling' },
    { id: 'f3', name: '新版结算页 V3', key: 'checkout-v3', enabled: true, rollout: 50, rules: { region: '全部', appVersion: '>= 8.0', authenticated: true }, status: 'rolling' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling' }
  ],
  plans: [
    { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: ['产品负责人', '研发负责人'], version: 3 },
    { id: 'p3', flagId: 'f3', scheduledAt: '2026-10-01T10:00', approvals: ['产品负责人', '研发负责人'], version: 1 },
    { id: 'p2', flagId: 'f2', scheduledAt: '2026-10-01T10:00', approvals: ['产品负责人', '研发负责人'], version: 2 }
  ],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ],
  layers: [
    { id: 'L1', name: '结算链路层', capacity: 5, queue: [] },
    { id: 'L2', name: '推荐链路层', capacity: 3, queue: [] }
  ],
  experiments: [
    { id: 'E1', layerId: 'L1', flagId: 'f1', name: '新版结算页 V2' },
    { id: 'E2', layerId: 'L1', flagId: 'f3', name: '新版结算页 V3' },
    { id: 'E3', layerId: 'L2', flagId: 'f2', name: '推荐模型 B' }
  ],
  assignments: [
    { userId: 'u-001', layerId: 'L1', experimentId: 'E1', registeredAt: 1 },
    { userId: 'u-002', layerId: 'L1', experimentId: 'E1', registeredAt: 2 },
    { userId: 'u-003', layerId: 'L1', experimentId: 'E2', registeredAt: 3 },
    { userId: 'u-004', layerId: 'L2', experimentId: 'E3', registeredAt: 4 },
    { userId: 'u-005', layerId: 'L2', experimentId: 'E3', registeredAt: 5 }
  ],
  evictions: [],
  globalCapacity: 8,
  nextSeq: 6,
  users: { ...seedUsers }
};

function load(): State { const saved = localStorage.getItem('yf58-flag-state'); return saved ? JSON.parse(saved) as State : structuredClone(seed); }

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    platform(state): PlatformState {
      return {
        layers: state.layers,
        experiments: state.experiments,
        assignments: state.assignments,
        evictions: state.evictions,
        globalCapacity: state.globalCapacity,
        nextSeq: state.nextSeq,
        users: state.users
      };
    },
    activeExperiment(state): Experiment | undefined {
      return state.experiments.find((e) => e.flagId === state.activeId);
    }
  },
  actions: {
    persist() { localStorage.setItem('yf58-flag-state', JSON.stringify(this.$state)); },
    audit(action: string, detail: string, actor = '当前操作人') { this.audit.unshift({ id: `a-${Date.now()}`, at: new Date().toLocaleTimeString(), actor, action, detail }); this.persist(); },
    select(id: string) { this.activeId = id; this.persist(); },

    // —— 实验层平台 ——
    /** 规则改动后重算：旧占位作废，已占住的先保留，超出的按登记先后退出并写清原因 */
    recalculatePlatform() {
      const evicted = platformRecalculate(this.platform, this.flags);
      for (const e of evicted) {
        this.evictions.unshift(e);
        const layer = this.layers.find((l) => l.id === e.layerId);
        const exp = this.experiments.find((x) => x.id === e.experimentId);
        this.audit('占位退出', `${e.userId} 退出 ${layer?.name ?? e.layerId}/${exp?.name ?? e.experimentId}：${e.reason}`);
      }
      this.persist();
    },
    /** 模拟用户命中，返回该用户在各层的命中情况（含层和实验） */
    simulateHit(user: UserInfo): { hit: boolean; reason: string; layerName?: string; experimentName?: string; experimentId?: string; queued?: boolean; allLayers: SimulateLayerResult[] } {
      const allLayers = platformSimulate(this.platform, this.flags, user);
      const activeExp = this.activeExperiment;
      if (activeExp) {
        const layerResult = allLayers.find((r) => r.layerId === activeExp.layerId);
        if (layerResult) {
          if (layerResult.experimentId === activeExp.id) {
            return { hit: layerResult.hit, reason: layerResult.reason, layerName: layerResult.layerName, experimentName: layerResult.experimentName, experimentId: layerResult.experimentId, queued: layerResult.queued, allLayers };
          }
          if (layerResult.hit) {
            return { hit: false, reason: `层内互斥：已在同层实验（${layerResult.experimentName}）`, layerName: layerResult.layerName, experimentName: layerResult.experimentName, experimentId: layerResult.experimentId, allLayers };
          }
          return { hit: false, reason: layerResult.reason, layerName: layerResult.layerName, allLayers };
        }
      }
      return { hit: false, reason: '当前开关未接入实验层', allLayers };
    },
    /** 把用户安排进实验（真正占位），处理层内容量、全局名额、层内互斥；层满排队 */
    assignToExperiment(user: UserInfo, experimentId: string) {
      const result = platformAssign(this.platform, this.flags, user, experimentId);
      const layer = this.layers.find((l) => l.id === this.experiments.find((e) => e.id === experimentId)?.layerId);
      const exp = this.experiments.find((e) => e.id === experimentId);
      if (result.ok) {
        this.audit('占位成功', `${user.id} 进入 ${layer?.name}/${exp?.name}`);
      } else if (result.queued) {
        this.audit('进入排队', `${user.id} 在 ${layer?.name} 排队（层容量已满）`);
      }
      this.persist();
      return result;
    },
    /** 用户离开某实验，腾出名额按 FIFO 补排队 */
    leaveExperiment(userId: string, layerId: string) {
      platformLeave(this.platform, this.flags, userId, layerId);
      this.persist();
    },
    /** 调整层容量，改动后重算 */
    updateLayerCapacity(layerId: string, capacity: number) {
      const layer = this.layers.find((l) => l.id === layerId);
      if (!layer) return;
      layer.capacity = Math.max(1, capacity);
      this.audit('调整层容量', `${layer.name} 容量 → ${layer.capacity}`);
      this.recalculatePlatform();
    },

    // —— 开关操作（改动后触发规则重算）——
    updateRule(rule: Partial<RuleSet>) {
      if (!this.active) return;
      this.active.rules = { ...this.active.rules, ...rule };
      this.active.status = 'draft';
      this.activePlan && (this.activePlan.approvals = []);
      this.audit('修改规则', JSON.stringify(this.active.rules));
      this.recalculatePlatform();
    },
    setRollout(value: number) {
      if (!this.active) return;
      this.active.rollout = value;
      this.audit('调整放量', `${this.active.key} → ${value}%`);
      this.recalculatePlatform();
    },
    schedule(value: string) { if (!this.active || !this.activePlan) return; this.activePlan.scheduledAt = value; this.active.status = 'scheduled'; this.audit('设置定时', `${this.active.key} 于 ${value} 生效`); },
    approve(role: string) { if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return; this.activePlan.approvals.push(role); this.active.status = this.activePlan.approvals.length >= 2 ? 'approved' : 'draft'; this.audit('审批发布', `${role} 已确认 ${this.active.key}`, role); this.persist(); },
    startRollout() {
      if (!this.active || this.active.status !== 'approved') return;
      this.active.enabled = true;
      this.active.status = 'rolling';
      this.audit('开始放量', `${this.active.key} 启用 ${this.active.rollout}%`);
      this.recalculatePlatform();
    },
    emergencyStop() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.status = 'stopped';
      this.audit('紧急停止', `${this.active.key} 已立即关闭`);
      this.recalculatePlatform();
    },
    rollback() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.rollout = 0;
      this.active.status = 'rolled-back';
      this.audit('执行回滚', `${this.active.key} 回滚至关闭状态`);
      this.recalculatePlatform();
    }
  }
});
