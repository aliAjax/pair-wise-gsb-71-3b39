export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 're-review' | 'approved' | 'rejected' | 'merged'
export type Severity = 'high' | 'medium' | 'low'

/** 基线生命周期状态：有效 / 已被新版本取代 / 因忽略规则变化而失效（等待复核） */
export type BaselineStatus = 'active' | 'superseded' | 'invalidated'

export interface Project {
  id: string
  name: string
  code: string
  owner: string
  pageCount: number
}

export interface DifferenceRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  severity: Severity
  pixels: number
  kind: 'layout' | 'content' | 'color' | 'environment'
  ignored: boolean
  ruleId?: string
}

/** 批准时固化的忽略规则快照，规则后续变化不影响历史依据的可读性 */
export interface IgnoreRuleSnapshot {
  ruleId: string
  ruleName: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  /** 快照时规则是否启用；规则被停用/修改/删除后，基线据此展示失效依据 */
  enabled: boolean
  /** 规则版本号，每次规则变化递增，用于判定快照是否过期 */
  ruleVersion: number
}

/** 差异区域忽略的证据：手工忽略留痕，规则忽略固化规则快照 */
export interface IgnoredRegionEvidence {
  regionId: string
  source: 'manual' | 'rule'
  /** 手工忽略的操作人 */
  operator?: string
  ruleId?: string
  ruleName?: string
  ignoredAt: string
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  /** 本次审批提交时基于的运行版本，用于审计并发提交 */
  basedOnVersion: number
  /** 批准时作为依据的忽略区域证据 */
  ignoredRegions?: IgnoredRegionEvidence[]
}

export interface ScreenshotRun {
  id: string
  name: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: RunStatus
  mismatchRate: number
  capturedAt: string
  baselineVersion: string
  currentVersion: string
  baselineImage?: string
  currentImage?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  /** 历次审批记录，最近一次在 review 中；复核后旧依据仍然可查 */
  reviewHistory?: ReviewRecord[]
  mergedRunIds?: string[]
  /** 乐观锁版本：每次忽略区域或审批变化都会递增，旧版本提交会被拒绝 */
  version: number
  /** 区域忽略证据，随运行持久化，不再只停留在当前页面 */
  ignoredEvidence: IgnoredRegionEvidence[]
  /** 当状态为 re-review 时，记录触发复核的规则信息 */
  invalidatedBy?: {
    ruleId: string
    ruleName: string
    reason: string
    changedAt: string
  }
}

export interface Baseline {
  id: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  version: string
  approvedBy: string
  reason: string
  approvedAt: string
  runId: string
  /** 兼容旧字段，迁移后与 status === 'active' 保持一致 */
  active: boolean
  /** 生命周期状态；旧数据迁移时由 active 推导 */
  status: BaselineStatus
  /** 批准时生效的忽略规则快照（含被忽略区域引用的规则） */
  ignoreRuleSnapshots: IgnoreRuleSnapshot[]
  /** 批准时被忽略区域的证据 */
  ignoredRegions: IgnoredRegionEvidence[]
  /** 失效时的规则变化说明 */
  invalidatedReason?: string
  invalidatedAt?: string
}

export interface IgnoreRule {
  id: string
  name: string
  projectId: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
  createdAt: string
  /** 规则版本：每次修改（含停用）递增，基线快照据此判定是否过期 */
  version: number
  updatedAt: string
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  trend: Array<{ date: string; total: number; failed: number }>
}

export interface RunFilters {
  projectId?: string
  page?: string
  device?: string
  theme?: string
  build?: string
  status?: string
  keyword?: string
}

export interface ReviewPayload {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  /** 提交时页面持有的运行版本，服务端据此做乐观锁校验 */
  expectedVersion: number
}

export interface IgnoreRegionsPayload {
  /** 忽略区域 id 列表（完整覆盖，便于撤销） */
  ignoredRegionIds: string[]
  operator: string
  /** 客户端持有的运行版本，与服务端不一致时拒绝写入 */
  expectedVersion?: number
}

export interface ImportRunPayload {
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  baselineVersion: string
  currentVersion: string
  files: Array<{ name: string; size: number; dataUrl: string }>
  baselineImage?: string
}

/** 审批冲突时返回的结构 */
export interface ReviewConflict {
  conflict: true
  current: ScreenshotRun
  message: string
}
