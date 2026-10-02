import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb } from '@/mocks/db'
import type {
  Baseline,
  DashboardData,
  IgnoreRegionsPayload,
  IgnoreRule,
  IgnoreRuleSnapshot,
  ImportRunPayload,
  Project,
  ReviewConflict,
  ReviewPayload,
  RunFilters,
  ScreenshotRun,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'Conflict',
  headers: {},
  config,
})

/** 自定义适配器需自行按状态码拒绝（axios 1.8+ 不再在分发层统一 settle） */
const rejectWithStatus = <T>(config: InternalAxiosRequestConfig, data: T, status: number): never => {
  throw new AxiosError(
    `Request failed with status code ${status}`,
    status >= 400 && status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE,
    config,
    undefined,
    respond(config, data, status),
  )
}

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

/** 简单通配匹配：* 匹配任意字符，其余按字面量比较 */
const wildcardMatch = (pattern: string, value: string): boolean => {
  if (!pattern || pattern === '*') return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

const ruleScopeMatches = (rule: IgnoreRule, run: ScreenshotRun): boolean =>
  (rule.projectId === 'all' || rule.projectId === run.projectId) &&
  wildcardMatch(rule.pagePattern, run.page) &&
  wildcardMatch(rule.devicePattern, run.device)

const snapshotRule = (rule: IgnoreRule): IgnoreRuleSnapshot => ({
  ruleId: rule.id,
  ruleName: rule.name,
  selector: rule.selector,
  pagePattern: rule.pagePattern,
  devicePattern: rule.devicePattern,
  maxDelta: rule.maxDelta,
  enabled: rule.enabled,
  ruleVersion: rule.version,
})

/** 批准依据：被忽略区域实际引用的规则 + 对本运行生效的启用规则 */
const buildApprovalSnapshots = (db: ReturnType<typeof readDb>, run: ScreenshotRun) => {
  const ids = new Set<string>()
  run.regions
    .filter((region) => region.ignored && region.ruleId)
    .forEach((region) => ids.add(region.ruleId as string))
  db.rules
    .filter((rule) => rule.enabled && ruleScopeMatches(rule, run))
    .forEach((rule) => ids.add(rule.id))
  return [...ids]
    .map((id) => db.rules.find((rule) => rule.id === id))
    .filter((rule): rule is IgnoreRule => Boolean(rule))
    .map(snapshotRule)
}

const baselineScopeKey = (b: Pick<Baseline, 'projectId' | 'page' | 'device' | 'theme'>) =>
  `${b.projectId}|${b.page}|${b.device}|${b.theme}`

/**
 * 规则发生停用/修改/删除后，引用该规则快照的有效基线立即失效，
 * 对应已批准运行回到待复核；历史基线与审批依据仍保留可查。
 * 规则来源的忽略区域重新标记为待判定（手工忽略保留）。
 */
const invalidateByRule = (
  db: ReturnType<typeof readDb>,
  rule: Pick<IgnoreRule, 'id' | 'name'>,
  reason: string,
) => {
  const now = new Date().toISOString()
  const impactedRunIds = new Set<string>()
  db.baselines.forEach((baseline) => {
    if (
      baseline.status === 'active' &&
      baseline.ignoreRuleSnapshots.some((snapshot) => snapshot.ruleId === rule.id)
    ) {
      baseline.status = 'invalidated'
      baseline.active = false
      baseline.invalidatedReason = reason
      baseline.invalidatedAt = now
      impactedRunIds.add(baseline.runId)
    }
  })
  db.runs.forEach((run) => {
    const usesRule = run.ignoredEvidence.some(
      (evidence) => evidence.source === 'rule' && evidence.ruleId === rule.id,
    )
    if (usesRule) {
      run.regions.forEach((region) => {
        if (region.ruleId === rule.id) region.ignored = false
      })
      run.ignoredEvidence = run.ignoredEvidence.filter(
        (evidence) => !(evidence.source === 'rule' && evidence.ruleId === rule.id),
      )
      run.version += 1
    }
    if (run.status === 'approved' && (impactedRunIds.has(run.id) || usesRule)) {
      run.status = 're-review'
      run.invalidatedBy = { ruleId: rule.id, ruleName: rule.name, reason, changedAt: now }
    }
  })
}

const isReviewPending = (status: ScreenshotRun['status']) =>
  status === 'pending' || status === 're-review'

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const today = new Date().toISOString().slice(0, 10)
    const dashboard: DashboardData = {
      pendingReview: db.runs.filter((run) => isReviewPending(run.status)).length,
      approvedToday: db.runs.filter(
        (run) => run.review?.decision === 'approved' && run.review.reviewedAt.startsWith(today),
      ).length,
      highRisk: db.runs.filter((run) => run.mismatchRate >= 5 && run.status !== 'merged').length,
      activeBaselines: db.baselines.filter((baseline) => baseline.status === 'active').length,
      trend: [
        { date: '09-23', total: 36, failed: 7 },
        { date: '09-24', total: 42, failed: 4 },
        { date: '09-25', total: 39, failed: 9 },
        { date: '09-26', total: 47, failed: 6 },
        { date: '09-27', total: 44, failed: 5 },
        { date: '09-28', total: 52, failed: 11 },
        { date: '09-29', total: 29, failed: 8 },
      ],
    }
    return respond(config, dashboard)
  }

  if (method === 'get' && path === '/runs') {
    const filters = (config.params ?? {}) as RunFilters
    const keyword = filters.keyword?.trim().toLowerCase()
    const data = db.runs.filter((run) => {
      return (
        (!filters.projectId || run.projectId === filters.projectId) &&
        (!filters.page || run.page === filters.page) &&
        (!filters.device || run.device === filters.device) &&
        (!filters.theme || run.theme === filters.theme) &&
        (!filters.build || run.build === filters.build) &&
        (!filters.status || run.status === filters.status) &&
        (!keyword ||
          run.name.toLowerCase().includes(keyword) ||
          run.page.toLowerCase().includes(keyword) ||
          run.id.toLowerCase().includes(keyword))
      )
    })
    return respond(config, data)
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/)
  if (method === 'get' && runMatch) {
    const run = db.runs.find((item) => item.id === runMatch[1])
    if (!run) throw new Error('运行记录不存在')
    return respond(config, run)
  }

  // 区域忽略随运行持久化，并推进运行版本，使仍停留在旧版本的审批提交失败
  const ignoreMatch = path.match(/^\/runs\/([^/]+)\/ignore$/)
  if (method === 'patch' && ignoreMatch) {
    const payload = parseBody<IgnoreRegionsPayload>(config)
    const run = db.runs.find((item) => item.id === ignoreMatch[1])
    if (!run) throw new Error('运行记录不存在')
    if (payload.expectedVersion !== undefined && payload.expectedVersion !== run.version) {
      rejectWithStatus<ReviewConflict>(
        config,
        {
          conflict: true,
          current: run,
          message: `忽略区域已在其他页面更新（当前版本 v${run.version}），请刷新后重试`,
        },
        409,
      )
    }
    const nowIso = new Date().toISOString()
    const ignoredIds = new Set(payload.ignoredRegionIds)
    run.regions.forEach((region) => {
      region.ignored = ignoredIds.has(region.id)
    })
    run.ignoredEvidence = run.regions
      .filter((region) => region.ignored)
      .map((region) => {
        const existing = run.ignoredEvidence.find((item) => item.regionId === region.id)
        if (existing) return existing
        return {
          regionId: region.id,
          source: region.ruleId ? 'rule' : 'manual',
          operator: region.ruleId ? undefined : payload.operator,
          ruleId: region.ruleId,
          ruleName: region.ruleId
            ? db.rules.find((rule) => rule.id === region.ruleId)?.name
            : undefined,
          ignoredAt: nowIso,
        }
      })
    run.version += 1
    writeDb(db)
    return respond(config, run)
  }

  const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && reviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const run = db.runs.find((item) => item.id === reviewMatch[1])
    if (!run) throw new Error('运行记录不存在')

    // 乐观锁：两个标签页同时提交同一运行时，持旧版本的后到提交失败且不覆盖结论
    if (payload.expectedVersion !== run.version) {
      rejectWithStatus<ReviewConflict>(
        config,
        {
          conflict: true,
          current: run,
          message: `该运行已被其他页面提交（版本 v${run.version}，状态：${run.status}），请基于最新版本重新复核`,
        },
        409,
      )
    }

    if (run.review) {
      run.reviewHistory = [...(run.reviewHistory ?? []), run.review]
    }
    run.status = payload.decision
    run.invalidatedBy = undefined
    run.review = {
      ...payload,
      reviewedAt: new Date().toISOString(),
      basedOnVersion: payload.expectedVersion,
      ignoredRegions: run.ignoredEvidence.map((item) => ({ ...item })),
    }
    run.version += 1

    if (payload.decision === 'approved') {
      // 同一项目 + 页面 + 设备 + 主题只保留一条生效基线，旧基线转为已取代
      db.baselines
        .filter(
          (item) =>
            item.status === 'active' && baselineScopeKey(item) === baselineScopeKey(run),
        )
        .forEach((item) => {
          item.status = 'superseded'
          item.active = false
        })
      db.baselines.unshift({
        id: `base-${Date.now()}`,
        projectId: run.projectId,
        page: run.page,
        device: run.device,
        theme: run.theme,
        version: run.currentVersion,
        approvedBy: payload.reviewer,
        reason: payload.reason,
        approvedAt: new Date().toISOString(),
        runId: run.id,
        active: true,
        status: 'active',
        ignoreRuleSnapshots: buildApprovalSnapshots(db, run),
        ignoredRegions: run.ignoredEvidence.map((item) => ({ ...item })),
      })
    }
    writeDb(db)
    return respond(config, run)
  }

  if (method === 'post' && path === '/runs/merge') {
    const ids = parseBody<string[]>(config)
    const selected = db.runs.filter((run) => ids.includes(run.id))
    if (selected.length < 2) throw new Error('至少选择两条运行记录进行合并')
    const [first, ...rest] = selected
    first.mergedRunIds = selected.map((run) => run.id)
    first.status = 'merged'
    first.mismatchRate =
      selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
    first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
    first.version += 1
    writeDb(db)
    return respond(config, first, 201)
  }

  if (method === 'post' && path === '/runs/import') {
    const payload = parseBody<ImportRunPayload>(config)
    if (
      !payload.projectId ||
      !payload.page.trim() ||
      !payload.device.trim() ||
      !payload.build.trim() ||
      payload.files.length === 0
    ) {
      throw new Error('项目、页面、设备、构建版本和截图文件不能为空')
    }
    const imported = payload.files.map((file, index) => {
      const runId = `run-${Date.now()}-${index + 1}`
      const mismatchRate = Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2))
      const severity = mismatchRate >= 5 ? 'high' : mismatchRate >= 2 ? 'medium' : 'low'
      const run: ScreenshotRun = {
        id: runId,
        name: `${payload.page} ${payload.device}回归`,
        projectId: payload.projectId,
        page: payload.page.trim(),
        device: payload.device.trim(),
        theme: payload.theme,
        build: payload.build.trim(),
        status: 'pending',
        mismatchRate,
        capturedAt: new Date().toISOString(),
        baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
        currentVersion: payload.currentVersion.trim() || payload.build.trim(),
        baselineImage: payload.baselineImage,
        currentImage: file.dataUrl,
        regions: [
          {
            id: `${runId}-r1`,
            x: 12 + index * 3,
            y: 22 + index * 2,
            width: 24,
            height: 14,
            severity,
            pixels: Math.round(file.size / 8 || 620),
            kind: 'layout',
            ignored: false,
          },
          {
            id: `${runId}-r2`,
            x: 58,
            y: 52,
            width: 16,
            height: 10,
            severity: severity === 'high' ? 'medium' : 'low',
            pixels: Math.round(file.size / 18 || 180),
            kind: 'color',
            ignored: false,
          },
        ],
        version: 1,
        ignoredEvidence: [],
      }
      return run
    })
    db.runs.unshift(...imported)
    writeDb(db)
    return respond(config, imported, 201)
  }

  if (method === 'get' && path === '/baselines') {
    const projectId = config.params?.projectId as string | undefined
    return respond(
      config,
      db.baselines.filter((baseline) => !projectId || baseline.projectId === projectId),
    )
  }

  if (method === 'get' && path === '/rules') {
    return respond<IgnoreRule[]>(config, db.rules)
  }

  if (method === 'post' && path === '/rules') {
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt' | 'version' | 'updatedAt'>>(config)
    const now = new Date().toISOString()
    const rule: IgnoreRule = {
      ...input,
      id: `rule-${Date.now()}`,
      createdAt: now,
      version: 1,
      updatedAt: now,
    }
    db.rules.unshift(rule)
    writeDb(db)
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) throw new Error('规则不存在')

    const wasEnabled = rule.enabled
    const before = {
      name: rule.name,
      projectId: rule.projectId,
      selector: rule.selector,
      pagePattern: rule.pagePattern,
      devicePattern: rule.devicePattern,
      maxDelta: rule.maxDelta,
    }
    Object.assign(rule, payload)
    rule.version += 1
    rule.updatedAt = new Date().toISOString()

    // 停用或收窄/修改规则会动摇批准依据；单纯启用（忽略更多区域）不追溯旧基线
    const disabled = wasEnabled && rule.enabled === false
    const materialEdited =
      (payload.name !== undefined && payload.name !== before.name) ||
      (payload.selector !== undefined && payload.selector !== before.selector) ||
      (payload.projectId !== undefined && payload.projectId !== before.projectId) ||
      (payload.pagePattern !== undefined && payload.pagePattern !== before.pagePattern) ||
      (payload.devicePattern !== undefined && payload.devicePattern !== before.devicePattern) ||
      (payload.maxDelta !== undefined && payload.maxDelta !== before.maxDelta)
    if (disabled) {
      invalidateByRule(db, rule, `规则“${rule.name}”已停用，其覆盖的忽略区域失去依据`)
    } else if (materialEdited) {
      invalidateByRule(db, rule, `规则“${rule.name}”已修改，批准时的规则快照与现行规则不一致`)
    }
    writeDb(db)
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) throw new Error('规则不存在')
    const [removed] = db.rules.splice(index, 1)
    invalidateByRule(db, removed, `规则“${removed.name}”已被删除，其覆盖的忽略区域失去依据`)
    writeDb(db)
    return respond(config, { success: true })
  }

  throw new Error(`Mock API 未实现：${method.toUpperCase()} ${path}`)
}

api.defaults.adapter = mockAdapter

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const reviewRun = async (id: string, payload: ReviewPayload): Promise<ScreenshotRun> =>
  (await api.patch<ScreenshotRun>(`/runs/${id}/review`, payload)).data
export const saveIgnoredRegions = async (
  id: string,
  payload: IgnoreRegionsPayload,
): Promise<ScreenshotRun> => (await api.patch<ScreenshotRun>(`/runs/${id}/ignore`, payload)).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ScreenshotRun[]> =>
  (await api.post<ScreenshotRun[]>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt' | 'version' | 'updatedAt'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const updateRule = async (
  id: string,
  payload: Partial<IgnoreRule>,
): Promise<IgnoreRule> => (await api.patch<IgnoreRule>(`/rules/${id}`, payload)).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data
