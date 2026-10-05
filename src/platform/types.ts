// 实验层平台领域模型

export interface Layer {
  id: string;
  name: string;
  /** 该层容量上限（所有实验共享） */
  capacity: number;
  /** 排队队列，存 userId，FIFO */
  queue: string[];
}

export interface Experiment {
  id: string;
  layerId: string;
  /** 关联的功能开关 id */
  flagId: string;
  name: string;
}

export interface Assignment {
  userId: string;
  layerId: string;
  experimentId: string;
  /** 登记序号，越小越先登记（用于规则改动时按登记先后退出） */
  registeredAt: number;
}

export interface EvictionRecord {
  id: string;
  at: string;
  userId: string;
  layerId: string;
  experimentId: string;
  /** 退出原因 */
  reason: string;
}

export interface UserInfo {
  id: string;
  region: string;
  appVersion: string;
  authenticated: boolean;
}

/** 开关的最小结构（平台只依赖这些字段，与 store 解耦） */
export interface FlagLike {
  id: string;
  name: string;
  enabled: boolean;
  rollout: number;
  rules: { region: string; appVersion: string; authenticated: boolean };
}

export interface PlatformState {
  layers: Layer[];
  experiments: Experiment[];
  assignments: Assignment[];
  evictions: EvictionRecord[];
  /** 全局名额上限 */
  globalCapacity: number;
  /** 登记序号自增 */
  nextSeq: number;
  /** 已知用户属性（规则改动重算时需要） */
  users: Record<string, UserInfo>;
}

export interface SimulateLayerResult {
  layerId: string;
  layerName: string;
  hit: boolean;
  experimentId?: string;
  experimentName?: string;
  reason: string;
  queued?: boolean;
}

export interface AssignResult {
  ok: boolean;
  reason: string;
  queued?: boolean;
  assignment?: Assignment;
}
