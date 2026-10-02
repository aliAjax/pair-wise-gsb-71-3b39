<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AxiosError } from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import StatusTag from '@/components/StatusTag.vue'
import { getRun, reviewRun, saveIgnoredRegions } from '@/api/http'
import { useReviewStore } from '@/stores/review'
import type { DifferenceRegion, ReviewCategory, ReviewConflict } from '@/types'

interface ReviewForm {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const reviewStore = useReviewStore()
const runId = computed(() => String(route.params.id))
const localRegions = ref<DifferenceRegion[]>([])
const conflict = ref<ReviewConflict | null>(null)

const form = reactive<ReviewForm>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})

const { data: run, isLoading } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
})

watch(
  run,
  (value) => {
    if (value) localRegions.value = value.regions.map((region) => ({ ...region }))
    reviewStore.setDifferenceFilter('all')
  },
  { immediate: true },
)

const visibleRegions = computed(() =>
  localRegions.value.filter(
    (region) =>
      reviewStore.differenceFilter === 'all' || region.severity === reviewStore.differenceFilter,
  ),
)

const suspiciousPixels = computed(() =>
  localRegions.value
    .filter((region) => !region.ignored)
    .reduce((total, region) => total + region.pixels, 0),
)

const evidenceOf = (regionId: string) =>
  run.value?.ignoredEvidence.find((item) => item.regionId === regionId)

const reviewMutation = useMutation({
  mutationFn: (payload: ReviewForm) =>
    reviewRun(runId.value, { ...payload, expectedVersion: run.value?.version ?? 0 }),
  onSuccess: async (updated) => {
    conflict.value = null
    Message.success(updated.review?.decision === 'approved' ? '审批通过，新基线已留痕' : '已驳回归并保留原基线')
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    await router.push('/approvals')
  },
  onError: async (error: unknown) => {
    // 并发提交：后到的旧版本失败，当前运行保留在待审/待复核队列
    if (error instanceof AxiosError && error.response?.status === 409) {
      const data = error.response.data as ReviewConflict
      conflict.value = data
      Message.error('提交失败：该运行已有更新版本，未覆盖对方的审批结论')
      await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
      await queryClient.invalidateQueries({ queryKey: ['runs'] })
      return
    }
    Message.error(error instanceof Error ? error.message : '审批提交失败')
  },
})

const ignoreMutation = useMutation({
  mutationFn: (ids: string[]) =>
    saveIgnoredRegions(runId.value, {
      ignoredRegionIds: ids,
      operator: form.reviewer || '匿名评审',
      expectedVersion: run.value?.version,
    }),
  onSuccess: async (updated) => {
    conflict.value = null
    queryClient.setQueryData(['run', runId.value], updated)
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
  },
  onError: async (error: unknown) => {
    if (error instanceof AxiosError && error.response?.status === 409) {
      const data = error.response.data as ReviewConflict
      conflict.value = data
      Message.error('忽略操作失败：其他页面已更新该运行，已为你刷新到最新版本')
      await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
      return
    }
    Message.error(error instanceof Error ? error.message : '忽略区域保存失败')
  },
})

const toggleIgnored = (target: DifferenceRegion) => {
  if (!run.value || ignoreMutation.isPending.value) return
  const region = localRegions.value.find((item) => item.id === target.id)
  if (!region) return
  region.ignored = !region.ignored
  ignoreMutation.mutate(localRegions.value.filter((item) => item.ignored).map((item) => item.id))
}

const handleDifferenceFilter = (value: string | number | boolean) => {
  const allowed = ['all', 'high', 'medium', 'low']
  if (allowed.includes(String(value))) {
    reviewStore.setDifferenceFilter(String(value) as 'all' | 'high' | 'medium' | 'low')
  }
}

const submitReview = () => {
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  if (form.reason.trim().length < 8) {
    Message.warning('审批原因至少 8 个字符')
    return
  }
  reviewMutation.mutate({ ...form })
}

const formatTime = (value: string) => value.slice(0, 16).replace('T', ' ')
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="run">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ run.name }}</h2>
            <StatusTag :status="run.status" />
            <a-tag color="arcoblue" bordered>评审版本 v{{ run.version }}</a-tag>
          </a-space>
          <p>{{ run.page }} · {{ run.device }} · {{ run.theme === 'light' ? '浅色主题' : '深色主题' }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回列表</a-button>
          <a-button
            type="primary"
            :loading="reviewMutation.isPending.value"
            :disabled="run.status === 'approved' || run.status === 'merged'"
            @click="submitReview"
          >
            <icon-check /> {{ run.status === 're-review' ? '提交复核' : '提交审批' }}
          </a-button>
        </a-space>
      </section>

      <a-alert
        v-if="run.status === 're-review' && run.invalidatedBy"
        type="warning"
        style="margin-bottom: 16px"
      >
        <template #title>基线依据已变化，等待复核</template>
        规则「{{ run.invalidatedBy.ruleName }}」于 {{ formatTime(run.invalidatedBy.changedAt) }}
        {{ run.invalidatedBy.reason }}，相关差异区域已重新标记，请复核后再决定是否批准。
      </a-alert>

      <a-alert v-if="conflict" type="error" closable style="margin-bottom: 16px" @close="conflict = null">
        <template #title>版本冲突（v{{ run.version }}）</template>
        {{ conflict.message }}。本次提交未生效，该运行仍保留在待审队列，请基于当前页面内容重新判断。
      </a-alert>

      <div class="run-facts">
        <div><span>差异率</span><strong :class="{ danger: run.mismatchRate >= 5 }">{{ run.mismatchRate.toFixed(2) }}%</strong></div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div><span>运行标识</span><strong>{{ run.id }}</strong></div>
        <div><span>构建链路</span><strong>{{ run.baselineVersion }} → {{ run.currentVersion }}</strong></div>
      </div>

      <div class="review-workspace">
        <div class="comparison-area">
          <div class="compare-toolbar">
            <a-space>
              <span class="toolbar-label">差异筛选</span>
              <a-radio-group
                type="button"
                :model-value="reviewStore.differenceFilter"
                size="small"
                @change="handleDifferenceFilter"
              >
                <a-radio value="all">全部</a-radio>
                <a-radio value="high">高</a-radio>
                <a-radio value="medium">中</a-radio>
                <a-radio value="low">低</a-radio>
              </a-radio-group>
            </a-space>
            <a-space>
              <a-button-group size="small">
                <a-button @click="reviewStore.setZoom(reviewStore.zoom - 10)"><icon-zoom-out /></a-button>
                <a-button>{{ reviewStore.zoom }}%</a-button>
                <a-button @click="reviewStore.setZoom(reviewStore.zoom + 10)"><icon-zoom-in /></a-button>
              </a-button-group>
              <a-button size="small" @click="reviewStore.setZoom(100)"><icon-refresh /> 复位</a-button>
            </a-space>
          </div>
          <div class="canvas-grid">
            <DiffCanvas :run="run" side="baseline" :zoom="reviewStore.zoom" :regions="visibleRegions" />
            <DiffCanvas :run="run" side="current" :zoom="reviewStore.zoom" :regions="visibleRegions" />
          </div>
        </div>

        <aside class="review-panel">
          <div class="panel-title">
            <div>
              <h3>差异区域</h3>
              <span>已按当前筛选展示 {{ visibleRegions.length }} 处 · 忽略会随运行持久化</span>
            </div>
            <a-tag color="red">{{ localRegions.filter((item) => !item.ignored).length }} 待判定</a-tag>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="region.id"
              class="region-item"
              :class="{ ignored: region.ignored }"
              :disabled="run.status === 'approved' || run.status === 'merged' || ignoreMutation.isPending.value"
              @click="toggleIgnored(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ region.kind === 'layout' ? '布局位移' : region.kind === 'color' ? '色彩变化' : region.kind === 'content' ? '内容变更' : '环境噪声' }}</strong>
                <small>区域 {{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px</small>
                <small v-if="evidenceOf(region.id)" class="evidence-line">
                  <template v-if="evidenceOf(region.id)?.source === 'rule'">
                    规则忽略：{{ evidenceOf(region.id)?.ruleName ?? evidenceOf(region.id)?.ruleId }}
                  </template>
                  <template v-else>
                    手工忽略：{{ evidenceOf(region.id)?.operator }} · {{ formatTime(evidenceOf(region.id)?.ignoredAt ?? '') }}
                  </template>
                </small>
              </span>
              <span class="ignore-action">{{ region.ignored ? '恢复' : '忽略' }}</span>
            </button>
          </div>

          <a-divider />

          <div class="panel-title">
            <div>
              <h3>评审结论</h3>
              <span>原因、批准人、版本和忽略依据会永久留痕</span>
            </div>
          </div>
          <a-form :model="form" layout="vertical" @submit-success="submitReview">
            <a-form-item
              field="category"
              label="变化类型"
              :rules="[{ required: true, message: '请选择变化类型' }]"
            >
              <a-select v-model="form.category">
                <a-option value="design-change">设计变更</a-option>
                <a-option value="render-error">渲染异常</a-option>
                <a-option value="environment-noise">环境噪声</a-option>
              </a-select>
            </a-form-item>
            <a-form-item
              field="decision"
              label="审批结论"
              :rules="[{ required: true, message: '请选择审批结论' }]"
            >
              <a-radio-group v-model="form.decision" type="button">
                <a-radio value="approved">批准为新基线</a-radio>
                <a-radio value="rejected">驳回归</a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item
              field="reviewer"
              label="批准人"
              :rules="[{ required: true, message: '请填写批准人' }]"
            >
              <a-input v-model="form.reviewer" />
            </a-form-item>
            <a-form-item
              field="reason"
              label="审批原因"
              :rules="[
                { required: true, message: '请填写审批原因' },
                { minLength: 8, message: '审批原因至少 8 个字符' },
              ]"
            >
              <a-textarea
                v-model="form.reason"
                :auto-size="{ minRows: 4, maxRows: 7 }"
                placeholder="说明业务需求、设计稿或异常依据"
              />
            </a-form-item>
            <a-alert v-if="form.decision === 'approved'" type="warning" style="margin-bottom: 16px">
              批准将基于当前版本 v{{ run.version }} 生成基线，并固化此刻生效的忽略规则快照；
              规则日后变化时该基线会自动失效并回到复核队列，历史依据仍可追溯。
            </a-alert>
            <a-button html-type="submit" type="primary" long :loading="reviewMutation.isPending.value">
              确认{{ form.decision === 'approved' ? '批准并创建基线' : '驳回' }}
            </a-button>
          </a-form>

          <div v-if="run.review" class="review-record">
            <h4>最近一次审批（基于 v{{ run.review.basedOnVersion }}）</h4>
            <dl>
              <dt>结论</dt><dd>{{ run.review.decision === 'approved' ? '已批准' : '已驳回' }}</dd>
              <dt>类型</dt><dd>{{ run.review.category }}</dd>
              <dt>人员</dt><dd>{{ run.review.reviewer }}</dd>
              <dt>时间</dt><dd>{{ formatTime(run.review.reviewedAt) }}</dd>
            </dl>
            <p>{{ run.review.reason }}</p>
            <div v-if="run.review.ignoredRegions?.length" class="review-evidence">
              <strong>批准时的忽略依据（{{ run.review.ignoredRegions.length }} 处）</strong>
              <ul>
                <li v-for="item in run.review.ignoredRegions" :key="item.regionId">
                  {{ item.source === 'rule' ? `规则「${item.ruleName ?? item.ruleId}」` : `手工忽略（${item.operator ?? '—'}）` }}
                  · 区域 {{ item.regionId }} · {{ formatTime(item.ignoredAt) }}
                </li>
              </ul>
            </div>
          </div>

          <div v-if="run.reviewHistory?.length" class="review-record">
            <h4>历史审批记录（{{ run.reviewHistory.length }}）</h4>
            <a-timeline>
              <a-timeline-item v-for="(record, index) in run.reviewHistory" :key="record.reviewedAt + '-' + index">
                <strong>{{ record.decision === 'approved' ? '已批准' : '已驳回' }} · {{ record.reviewer }}</strong>
                <p>{{ record.reason }}</p>
                <small>基于 v{{ record.basedOnVersion }} · {{ formatTime(record.reviewedAt) }}</small>
              </a-timeline-item>
            </a-timeline>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
