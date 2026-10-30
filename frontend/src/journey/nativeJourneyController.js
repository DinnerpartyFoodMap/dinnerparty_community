// 日记 · 同好原生页的网页侧控制器：页面模型由这里构建，所有请求、草稿与权限仍由网页执行。
// 原生只显示 rows / form / calendar / images，并把动作、筛选、表单值与照片回传这里。
// 地图选点与分享画布属于工具流程，交回现有网页界面；其余页面均在原生 SwiftUI 中呈现。
import { t, tx } from '../i18n/index.js';
import { copyText } from '../platform/share.js';
import { buildPublicUrl } from '../platform/runtimeConfig.js';
import { deleteLocalCompose, deleteLocalDraft, listLocalComposes, loadLocalDraft, saveLocalDraft } from '../platform/localDraftStore.js';
import { getTokenUserId } from '../platform/credentialStore.js';
import { diaryReportPrefill, userReportPrefill } from '../feedback/feedbackTypes.js';

const MAX_PHOTOS = 12;
const STOP_PHOTO_LIMIT = 12;
const TIMER_KEYS = new Set();

const newId = () => globalThis.crypto?.randomUUID?.() || `native_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function formatDay(value) {
  if (!value) return t('journey:shared.noDate');
  if (value === today()) return t('journey:shared.today');
  const [y, m, d] = value.split('-').map(Number);
  return y === new Date().getFullYear() ? t('journey:shared.monthDay', { m, d }) : t('journey:shared.fullDate', { y, m, d });
}

function formatRange(start, end) {
  return !end || end === start ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`;
}

function centerLabel(center) {
  if (!center) return '';
  return center.name || t('journey:shared.selectedMapLocation');
}

function newDocument(date = today()) {
  return {
    title: t('journey:reviewUtils.defaultTitle'),
    start_date: date,
    end_date: date,
    summary: '',
    stops: [],
    entry_media_ids: [],
    media_meta: {},
    intended_visibility: 'public'
  };
}

function newStop(patch = {}) {
  return {
    id: newId(),
    name: t('journey:stopCard.pendingShop'),
    note: '',
    lng: null,
    lat: null,
    place_id: null,
    address: '',
    source: 'manual',
    confirmed: false,
    visit_status: 'visited',
    at: '',
    mood: '',
    media_ids: [],
    expenses: [],
    excerpts: [],
    excerpt_edited: '',
    ...patch
  };
}

function hasContent(payload, mediaIds) {
  return !!(String(payload.text || '').trim() || mediaIds.length);
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function base64Blob(value) {
  try {
    const text = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/jpeg' });
  } catch (error) {
    return null;
  }
}

function excerptText(stop) {
  if (stop.excerpt_edited) return stop.excerpt_edited;
  return (stop.excerpts || []).map((item) => item.text).join(t('journey:reviewUtils.excerptSeparator'));
}

/**
 * 控制器：维护原生页面栈与素材/草稿状态；每次动作返回新的页面模型。
 * onUpdate(page) 用于生成任务等异步进度；onClose() 结束原生页。
 */
export function createNativeJourneyController({
  backendUrl,
  token,
  user,
  onClose,
  onOpenPlace,
  onOpenFeedback,
  onShowMap,
  onOpenShare,
  onRequireAuth,
  onUpdate
}) {
  const actions = new Map();
  const forms = new Map();
  const timers = new Map();
  let actionSeq = 0;
  let formSeq = 0;
  let stack = [];
  let composerCache = new Map();
  let review = null;
  let generation = new Map();
  let community = null;
  let share = null;
  const userId = getTokenUserId(token);
  const calendarState = { month: today().slice(0, 7), day: '', search: '', tab: '' };

  async function api(path, options = {}) {
    const headers = {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers
    };
    const res = await fetch(`${backendUrl}${path}`, { ...options, headers });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) onRequireAuth?.();
      throw Object.assign(new Error(data.error || t('journey:feedback.requestFailed', { status: res.status })), { status: res.status, code: data.code, details: data.details });
    }
    return data;
  }

  function action(title, run, options = {}) {
    const id = `a${++actionSeq}`;
    actions.set(id, run);
    const result = { id, title, tone: options.tone || '', kind: options.kind || 'action' };
    if (options.confirm) result.confirm = options.confirm;
    return result;
  }

  function registerForm({ title = '', message = '', fields, submitTitle, openTitle = '', handler }) {
    const id = `f${++formSeq}`;
    forms.set(id, handler);
    return {
      id,
      title,
      message,
      submitId: id,
      submitTitle,
      openTitle: openTitle || submitTitle,
      cancelTitle: t('common:action.cancel'),
      fields
    };
  }

  function formAction(title, build) {
    const id = `a${++actionSeq}`;
    actions.set(id, async () => ({ form: build() }));
    return { id, title, kind: 'action' };
  }

  function clearTimers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  function basePage(id, title, options = {}) {
    return {
      id: `${id}-${newId()}`,
      title,
      subtitle: options.subtitle || '',
      canGoBack: options.canGoBack !== false,
      closeTitle: t('common:action.close'),
      backTitle: t('common:action.back'),
      searchPlaceholder: options.searchPlaceholder || '',
      searchValue: options.searchValue || '',
      tabs: options.tabs || [],
      selectedTab: options.selectedTab || '',
      sections: options.sections || [],
      buttons: options.buttons || [],
      pagerText: '',
      pagerPrev: '',
      pagerNext: '',
      empty: options.empty || '',
      message: options.message || '',
      error: options.error || '',
      loading: !!options.loading
    };
  }

  async function build(type, params = {}) {
    actions.clear();
    forms.clear();
    switch (type) {
      case 'entry': return entryPage();
      case 'composer': return composerPage(params);
      case 'generation': return generationPage(params);
      case 'review': return reviewPage(params);
      case 'calendar': return calendarPage();
      case 'detail': return detailPage(params);
      case 'unfinished': return unfinishedPage();
      case 'media': return mediaPage();
      case 'public': return publicPage(params);
      case 'community': return communityPage(params);
      case 'share': return sharePage(params);
      default: return entryPage();
    }
  }

  async function go(type, params = {}) {
    clearTimers();
    stack.push({ type, params });
    return build(type, params);
  }

  async function resetTo(type, params = {}) {
    clearTimers();
    stack = [{ type, params }];
    return build(type, params);
  }

  async function back() {
    clearTimers();
    stack.pop();
    if (!stack.length) return entryPage();
    const top = stack[stack.length - 1];
    return build(top.type, top.params);
  }

  // ---- 入口 ----
  async function entryPage() {
    let material = 0;
    let unfinished = 0;
    try {
      const data = await api('/api/journeys/unfinished');
      material = data?.material?.length || 0;
      unfinished = data?.count || 0;
    } catch (error) { /* 未完成计数失败不影响入口 */ }
    const rows = [
      {
        id: 'composer',
        title: t('journey:common.feature.generate'),
        subtitle: material ? t('journey:entry.composerHintUnfinished', { material }) : t('journey:entry.composerHint'),
        actions: [action(t('journey:common.feature.generate'), async () => ({ page: await go('composer', {}) }))]
      },
      {
        id: 'calendar',
        title: t('journey:common.feature.calendar'),
        subtitle: t('journey:entry.calendarHint'),
        badge: unfinished ? String(unfinished) : '',
        badgeTone: unfinished ? 'warning' : '',
        actions: [action(t('journey:common.feature.calendar'), async () => ({ page: await go('calendar', {}) }))]
      },
      {
        id: 'community',
        title: t('journey:common.feature.community'),
        subtitle: t('journey:entry.communityHint'),
        actions: [action(t('journey:common.feature.community'), async () => ({ page: await go('community', { section: 'neighbors' }) }))]
      }
    ];
    return basePage('journey-entry', t('journey:workspace.launcher'), {
      canGoBack: false,
      sections: [{ id: 'entry', title: '', rows }]
    });
  }

  // ---- 素材 ----
  function defaultPayload(params) {
    const preset = params.preset || {};
    return {
      text: preset.text || '',
      start_date: preset.date || today(),
      end_date: preset.date || today(),
      center: preset.center || null,
      intended_visibility: 'public'
    };
  }

  async function loadComposer(params) {
    const id = params.composeId || newId();
    if (!composerCache.has(id)) {
      composerCache.set(id, {
        id,
        payload: params.localCompose?.payload ? { ...defaultPayload(params), ...params.localCompose.payload } : defaultPayload(params),
        mediaIds: params.localCompose?.mediaIds || [],
        revision: 0,
        loaded: !params.composeId,
        closed: ''
      });
    }
    const state = composerCache.get(id);
    if (params.composeId && !state.loaded) {
      try {
        const data = await api(`/api/journeys/compose-drafts/${encodeURIComponent(id)}`);
        const payload = data.payload || {};
        state.payload = {
          text: payload.text || '',
          start_date: payload.start_date || today(),
          end_date: payload.end_date || payload.start_date || today(),
          center: payload.center || null,
          intended_visibility: payload.intended_visibility === 'private' ? 'private' : 'public'
        };
        state.mediaIds = Array.isArray(payload.media_ids) ? payload.media_ids : [];
        state.revision = data.revision || 0;
      } catch (error) {
        state.closed = error.status === 410 ? error.message : '';
      }
      state.loaded = true;
    }
    return state;
  }

  async function saveComposer(state) {
    if (!hasContent(state.payload, state.mediaIds)) return null;
    const body = {
      revision: state.revision,
      payload: {
        ...state.payload,
        media_ids: state.mediaIds,
        media_notes: {}
      }
    };
    const data = await api(`/api/journeys/compose-drafts/${encodeURIComponent(state.id)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    state.revision = data.revision ?? state.revision;
    return data;
  }

  async function uploadComposerPhoto(state, imageBase64) {
    const image = String(imageBase64 || '');
    if (!image) return null;
    if (state.mediaIds.length >= MAX_PHOTOS) throw new Error(t('journey:photoPicker.maxPhotos', { MAX_PHOTOS }));
    const blob = base64Blob(image);
    if (!blob) throw new Error(t('journey:photoPicker.openFailed'));
    const form = new FormData();
    form.append('image', blob, 'photo.jpg');
    const media = await api('/api/journeys/media', { method: 'POST', body: form });
    state.mediaIds.push(media.id);
    return media;
  }

  async function composerPage(params) {
    const state = await loadComposer(params);
    const form = registerForm({
      title: t('journey:composer.textLabel'),
      message: t('journey:composer.nativeHint'),
      submitTitle: t('journey:composer.saveDraft'),
      openTitle: t('common:action.edit'),
      fields: [
        { id: 'text', kind: 'textarea', label: t('journey:composer.textLabel'), value: state.payload.text, placeholder: t('journey:composer.textPlaceholder') },
        { id: 'start_date', kind: 'date', label: t('journey:composer.date.label'), value: state.payload.start_date },
        { id: 'end_date', kind: 'date', label: t('journey:composer.date.end'), value: state.payload.end_date },
        { id: 'visibility', kind: 'select', label: t('journey:composer.visibility.label'), value: state.payload.intended_visibility, options: [
          { id: 'public', title: t('journey:common.label.public') },
          { id: 'private', title: t('journey:common.label.private') }
        ] },
        { id: 'center', kind: 'info', label: t('journey:composer.address.label'), value: centerLabel(state.payload.center) || t('journey:composer.address.unset') }
      ],
      handler: async (values) => {
        state.payload = {
          ...state.payload,
          text: String(values.text || ''),
          start_date: String(values.start_date || today()),
          end_date: String(values.end_date || values.start_date || today()),
          intended_visibility: values.visibility === 'private' ? 'private' : 'public'
        };
        if (state.payload.end_date < state.payload.start_date) state.payload.end_date = state.payload.start_date;
        await saveComposer(state);
        return { page: await composerPage({ composeId: state.id }), message: t('journey:composer.draftSaved') };
      }
    });
    const photos = state.mediaIds.map((id, index) => ({
      id,
      caption: t('journey:photoPicker.photoLabel', { index: index + 1, status: '', kind: '' }),
      protectedImage: `journey:${id}`,
      actions: [action(t('common:action.remove'), async () => {
        state.mediaIds = state.mediaIds.filter((value) => value !== id);
        return { page: await composerPage({ composeId: state.id }) };
      }, { tone: 'danger', confirm: { title: t('common:action.remove'), message: t('journey:review.photos.removeFromEntry'), button: t('common:action.remove') } })]
    }));
    const sections = [];
    if (state.closed) sections.push({ id: 'closed', title: '', text: state.closed });
    if (photos.length) sections.push({ id: 'photos', title: t('journey:review.photos.title', { count: photos.length }), images: photos });
    else sections.push({ id: 'photos-empty', title: t('journey:review.photos.empty'), text: '' });
    sections.push({ id: 'composer-form', title: '', form });
    const buttons = [
      action(t('common:action.addImage'), async (payload) => {
        try {
          await uploadComposerPhoto(state, payload?.image);
          return { page: await composerPage({ composeId: state.id }) };
        } catch (error) {
          return { error: error.message };
        }
      }, { kind: 'photo' }),
      action(t('journey:common.action.generateDraft'), async () => {
        const saved = await saveComposer(state);
        if (!saved) return { error: t('journey:composer.blocker.empty') };
        const job = await api(`/api/journeys/compose-drafts/${encodeURIComponent(state.id)}/generate`, {
          method: 'POST',
          body: JSON.stringify({ compose_revision: state.revision, request_id: newId(), text_only: false })
        });
        return { page: await go('generation', { composeId: state.id, jobId: job.id }) };
      }, { tone: 'primary' }),
      action(t('journey:composer.manualSave'), async () => {
        await saveComposer(state);
        const document = {
          ...newDocument(state.payload.start_date),
          start_date: state.payload.start_date,
          end_date: state.payload.end_date,
          entry_media_ids: [...state.mediaIds],
          source_input: {
            text: state.payload.text,
            start_date: state.payload.start_date,
            end_date: state.payload.end_date,
            center: state.payload.center
          },
          intended_visibility: state.payload.intended_visibility
        };
        review = null;
        return { page: await go('review', { journal: { id: null, revision: 0, compose_draft_id: state.id, compose_revision: state.revision, document } }) };
      })
    ];
    return basePage('journey-composer', t('journey:common.feature.generate'), {
      subtitle: formatRange(state.payload.start_date, state.payload.end_date),
      sections,
      buttons
    });
  }

  // ---- 生成 ----
  function generationStatus(state) {
    const status = state?.job?.status || 'queued';
    const steps = {
      queued: t('journey:generation.step.queued'),
      running: t('journey:generation.step.running'),
      ready: t('journey:generation.step.ready'),
      failed: t('journey:generation.step.failed')
    };
    return { status, label: steps[status] || status };
  }

  function startGenerationPoll(composeId, jobId, params) {
    if (timers.has(jobId)) return;
    const tick = async () => {
      try {
        const job = await api(`/api/journeys/jobs/${encodeURIComponent(jobId)}`);
        const state = generation.get(jobId) || { composeId, jobId };
        state.job = job;
        generation.set(jobId, state);
        if (job.status === 'queued' || job.status === 'running') {
          timers.set(jobId, setTimeout(tick, 2000));
          onUpdate?.(await generationPage(params));
          return;
        }
        timers.delete(jobId);
        if (job.status === 'ready' && job.draft_id) {
          const page = await go('review', { draftId: job.draft_id, notice: job.output?.notice });
          onUpdate?.(page);
          return;
        }
        onUpdate?.(await generationPage(params));
      } catch (error) {
        const state = generation.get(jobId) || { composeId, jobId };
        state.error = error.status === 404 ? t('journey:generation.jobMissing') : t('journey:generation.progressRetrying');
        generation.set(jobId, state);
        timers.set(jobId, setTimeout(tick, 4000));
        onUpdate?.(await generationPage(params));
      }
    };
    timers.set(jobId, setTimeout(tick, 0));
  }

  async function generationPage(params) {
    const state = generation.get(params.jobId) || { composeId: params.composeId, jobId: params.jobId };
    if (!state.job && !state.error) startGenerationPoll(params.composeId, params.jobId, params);
    const { status, label } = generationStatus(state);
    const sections = [{
      id: 'status',
      title: '',
      text: [label, ['queued', 'running'].includes(status) ? t('journey:generation.waitHint') : '', state.error || ''].filter(Boolean).join('\n')
    }];
    if (status === 'failed' && state.job?.error) {
      sections.push({ id: 'error', title: '', text: t('journey:generation.failedNotice', { error: state.job.error }) });
    }
    const buttons = [];
    if (status === 'failed') {
      buttons.push(action(t('journey:generation.regenerate'), async () => {
        const compose = await api(`/api/journeys/compose-drafts/${encodeURIComponent(params.composeId)}`);
        const next = await api(`/api/journeys/compose-drafts/${encodeURIComponent(params.composeId)}/generate`, {
          method: 'POST',
          body: JSON.stringify({ compose_revision: compose.revision, request_id: newId(), text_only: false })
        });
        return { page: await go('generation', { composeId: params.composeId, jobId: next.id }) };
      }));
      buttons.push(action(t('journey:generation.backToMaterial'), async () => ({ page: await go('composer', { composeId: params.composeId }) })));
    }
    if (status === 'ready' && state.job?.draft_id) {
      buttons.push(action(t('journey:generation.startReview'), async () => ({ page: await go('review', { draftId: state.job.draft_id }) })));
    }
    buttons.push(action(t('journey:generation.backToCalendar'), async () => ({ page: await resetTo('calendar', {}) })));
    return basePage('journey-generation', t('journey:common.action.generateDraft'), {
      subtitle: label,
      sections,
      buttons
    });
  }

  // ---- 核对 / 修改 ----
  async function loadReview(params) {
    if (params.journal) {
      review = {
        draftId: null,
        journeyId: params.journal.id || null,
        baseRevision: params.journal.revision || 0,
        draftRevision: 0,
        composeDraftId: params.journal.compose_draft_id || null,
        composeRevision: params.journal.compose_revision || null,
        document: params.journal.document || newDocument(),
        notice: params.notice || ''
      };
      return review;
    }
    if (params.draftId) {
      const data = await api(`/api/journeys/drafts/${encodeURIComponent(params.draftId)}`);
      review = {
        draftId: params.draftId,
        journeyId: data.journey_id || null,
        baseRevision: data.base_revision || 0,
        draftRevision: data.revision || 0,
        composeDraftId: data.compose_draft_id || null,
        composeRevision: null,
        document: data.document || newDocument(),
        notice: params.notice || ''
      };
      return review;
    }
    if (params.journeyId) {
      const data = await api(`/api/journeys/${encodeURIComponent(params.journeyId)}`);
      review = {
        draftId: null,
        journeyId: data.id,
        baseRevision: data.revision || 0,
        draftRevision: 0,
        composeDraftId: null,
        composeRevision: null,
        document: { ...data.document, intended_visibility: params.visibility || data.visibility },
        notice: ''
      };
      return review;
    }
    review = {
      draftId: null,
      journeyId: null,
      baseRevision: 0,
      draftRevision: 0,
      composeDraftId: null,
      composeRevision: null,
      document: newDocument(params.date || today()),
      notice: ''
    };
    return review;
  }

  function reviewStopForm(stop) {
    return registerForm({
      title: stop.name,
      message: t('journey:review.nativeHint') || '',
      submitTitle: t('common:action.save'),
      openTitle: t('common:action.edit'),
      fields: [
        { id: 'name', kind: 'text', label: t('journey:stopCard.field.name'), value: stop.name },
        { id: 'at', kind: 'text', label: t('journey:stopCard.field.time'), value: stop.at || '' },
        { id: 'address', kind: 'text', label: t('journey:composer.address.label'), value: stop.address || '', placeholder: t('journey:composer.address.label') },
        { id: 'text', kind: 'textarea', label: t('journey:stopCard.textLabel'), value: excerptText(stop) },
        { id: 'note', kind: 'textarea', label: t('journey:stopCard.field.mood'), value: stop.note || '' },
        { id: 'latitude', kind: 'number', label: t('admin:exhibitions.latitude'), value: stop.lat ?? '' },
        { id: 'longitude', kind: 'number', label: t('admin:exhibitions.longitude'), value: stop.lng ?? '' }
      ],
      handler: async (values) => {
        const lat = values.latitude === '' ? null : Number(values.latitude);
        const lng = values.longitude === '' ? null : Number(values.longitude);
        const located = Number.isFinite(lat) && Number.isFinite(lng);
        const text = String(values.text || '');
        const source = (stop.excerpts || []).map((item) => item.text).join(t('journey:reviewUtils.excerptSeparator'));
        Object.assign(stop, {
          name: String(values.name || '').trim() || stop.name,
          at: String(values.at || '').trim(),
          address: String(values.address || '').trim(),
          note: String(values.note || '').trim(),
          excerpt_edited: text === source ? '' : text,
          lat: located ? lat : null,
          lng: located ? lng : null,
          confirmed: located || stop.confirmed,
          visit_status: 'visited'
        });
        return { page: await reviewPage({}), message: t('journey:review.savedWithPending') };
      }
    });
  }

  async function reviewPage(params) {
    const wantsNew = !!(params.journal || params.draftId || params.journeyId);
    if (!review || wantsNew) await loadReview(params);
    const document = review.document;
    const stops = document.stops || [];
    const infoForm = registerForm({
      title: t('journey:review.title'),
      submitTitle: t('common:action.save'),
      openTitle: t('common:action.edit'),
      fields: [
        { id: 'title', kind: 'text', label: t('journey:review.field.title'), value: document.title || '' },
        { id: 'start_date', kind: 'date', label: t('journey:review.field.startDate'), value: document.start_date },
        { id: 'end_date', kind: 'date', label: t('journey:review.field.endDate'), value: document.end_date },
        { id: 'summary', kind: 'textarea', label: t('journey:review.field.summary'), value: document.summary || '' },
        { id: 'visibility', kind: 'select', label: t('journey:review.visibility'), value: document.intended_visibility === 'private' ? 'private' : 'public', options: [
          { id: 'public', title: t('journey:common.label.public') },
          { id: 'private', title: t('journey:common.label.private') }
        ] }
      ],
      handler: async (values) => {
        document.title = String(values.title || '').trim() || document.title;
        document.start_date = String(values.start_date || document.start_date);
        document.end_date = String(values.end_date || document.end_date);
        if (document.end_date < document.start_date) document.end_date = document.start_date;
        document.summary = String(values.summary || '');
        document.intended_visibility = values.visibility === 'private' ? 'private' : 'public';
        return { page: await reviewPage({}) };
      }
    });
    const rows = stops.map((stop, index) => ({
      id: stop.id,
      title: `${index + 1}. ${stop.name}`,
      subtitle: [stop.at || '', stop.address || ''].filter(Boolean).join(' · '),
      detail: excerptText(stop).slice(0, 160),
      badge: stop.confirmed ? '' : t('journey:stopCard.badge.pending'),
      badgeTone: stop.confirmed ? '' : 'warning',
      actions: [
        formAction(t('common:action.edit'), () => reviewStopForm(stop)),
        action(t('journey:stopCard.moveUp'), async () => {
          if (index <= 0) return {};
          [stops[index - 1], stops[index]] = [stops[index], stops[index - 1]];
          return { page: await reviewPage({}) };
        }),
        action(t('journey:stopCard.moveDown'), async () => {
          if (index >= stops.length - 1) return {};
          [stops[index + 1], stops[index]] = [stops[index], stops[index + 1]];
          return { page: await reviewPage({}) };
        }),
        action(t('common:action.remove'), async () => {
          document.stops = stops.filter((item) => item.id !== stop.id);
          return { page: await reviewPage({}) };
        }, { tone: 'danger', confirm: { title: t('common:action.remove'), message: t('journey:review.confirmRemoveStop', { name: stop.name }), button: t('common:action.remove') } })
      ]
    }));
    const addStop = formAction(t('journey:review.addPlace'), () => registerForm({
      title: t('journey:review.addPlace'),
      message: t('journey:review.nativeHint') || '',
      submitTitle: t('common:action.save'),
      openTitle: t('common:action.edit'),
      fields: [
        { id: 'name', kind: 'text', label: t('journey:stopCard.field.name'), value: '' },
        { id: 'at', kind: 'text', label: t('journey:stopCard.field.time'), value: '' },
        { id: 'address', kind: 'text', label: t('journey:stopCard.field.name'), value: '' },
        { id: 'text', kind: 'textarea', label: t('journey:stopCard.textLabel'), value: '' },
        { id: 'latitude', kind: 'number', label: t('admin:exhibitions.latitude'), value: '' },
        { id: 'longitude', kind: 'number', label: t('admin:exhibitions.longitude'), value: '' }
      ],
      handler: async (values) => {
        const lat = values.latitude === '' ? null : Number(values.latitude);
        const lng = values.longitude === '' ? null : Number(values.longitude);
        const located = Number.isFinite(lat) && Number.isFinite(lng);
        const text = String(values.text || '');
        document.stops.push(newStop({
          name: String(values.name || '').trim() || t('journey:stopCard.pendingShop'),
          at: String(values.at || '').trim(),
          address: String(values.address || '').trim(),
          excerpt_edited: text,
          lat: located ? lat : null,
          lng: located ? lng : null,
          confirmed: located,
          visit_status: 'visited'
        }));
        return { page: await reviewPage({}) };
      }
    }));
    const photos = (document.entry_media_ids || []).map((id, index) => ({
      id,
      caption: t('journey:photoPicker.photoLabel', { index: index + 1, status: '', kind: '' }),
      protectedImage: `journey:${id}`,
      actions: [action(t('common:action.remove'), async () => {
        document.entry_media_ids = (document.entry_media_ids || []).filter((value) => value !== id);
        document.stops = document.stops.map((stop) => ({ ...stop, media_ids: (stop.media_ids || []).filter((value) => value !== id) }));
        return { page: await reviewPage({}) };
      }, { tone: 'danger' })]
    }));
    const sections = [];
    if (review.notice) sections.push({ id: 'notice', title: '', text: review.notice });
    sections.push({ id: 'info', title: t('journey:review.titleSectionLabel'), form: infoForm });
    if (rows.length) sections.push({ id: 'stops', title: t('journey:common.feature.diary'), rows });
    else sections.push({ id: 'stops-empty', title: t('journey:review.noStopsLabel'), text: t('journey:review.noStopsHint') });
    if (photos.length) sections.push({ id: 'photos', title: t('journey:review.photos.title', { count: photos.length }), images: photos });
    const buttons = [
      addStop,
      action(t('common:action.addImage'), async (payload) => {
        try {
          const image = String(payload?.image || '');
          if (!image) return {};
          if ((document.entry_media_ids || []).length >= 60) return { error: t('journey:review.maxPhotos') };
          const blob = base64Blob(image);
          if (!blob) return { error: t('journey:review.openFailed') };
          const form = new FormData();
          form.append('image', blob, 'photo.jpg');
          const media = await api('/api/journeys/media', { method: 'POST', body: form });
          document.entry_media_ids = [...(document.entry_media_ids || []), media.id];
          return { page: await reviewPage({}) };
        } catch (error) {
          return { error: error.message };
        }
      }, { kind: 'photo' }),
      action(t('journey:review.save.private'), async () => commitReview('private'), { tone: 'primary' }),
      action(t('journey:review.save.publish'), async () => commitReview('public'), { tone: 'primary' })
    ];
    return basePage('journey-review', review.journeyId ? t('journey:review.editTitle') : t('journey:review.title'), {
      subtitle: formatRange(document.start_date, document.end_date),
      sections,
      buttons
    });
  }

  async function persistReviewDraft() {
    if (!review) return null;
    const document = review.document;
    review.draftId = review.draftId || newId();
    const data = await api(`/api/journeys/drafts/${encodeURIComponent(review.draftId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        journey_id: review.journeyId || null,
        base_revision: review.baseRevision || 0,
        draft_revision: review.draftRevision || 0,
        document,
        ...(review.composeDraftId && !review.draftRevision ? { compose_draft_id: review.composeDraftId, compose_revision: review.composeRevision } : {})
      })
    });
    review.draftRevision = data.revision;
    return data;
  }

  async function commitReview(visibilityOverride) {
    await persistReviewDraft();
    const visibility = visibilityOverride || (review.document.intended_visibility === 'private' ? 'private' : 'public');
    const preview = await api(`/api/journeys/drafts/${encodeURIComponent(review.draftId)}/map-preview`, {
      method: 'POST',
      body: JSON.stringify({ draft_revision: review.draftRevision, visibility })
    });
    if (visibility === 'public' && Number(preview.counts?.conflict) > 0) {
      return { error: t('journey:review.resolveConflictsFirst') };
    }
    const result = await api(`/api/journeys/drafts/${encodeURIComponent(review.draftId)}/commit`, {
      method: 'POST',
      body: JSON.stringify({
        draft_revision: review.draftRevision,
        visibility,
        preview_hash: preview.preview_hash,
        request_id: newId(),
        as_copy: false
      })
    });
    const message = visibility === 'public'
      ? t('journey:review.savedPublic', { linked: result.linked || 0, created: '' })
      : t('journey:review.savedPrivate');
    review = null;
    stack = stack.filter((item) => item.type !== 'review');
    return { page: await go('detail', { journeyId: result.journey_id, message }) };
  }

  // ---- 日历 ----
  async function calendarPage() {
    const [from, to] = monthRange(calendarState.month);
    let entries = [];
    let draftDates = [];
    if (calendarState.search || calendarState.tab) {
      const query = new URLSearchParams({ q: calendarState.search, visibility: calendarState.tab });
      entries = await api(`/api/journeys/search?${query}`);
    } else {
      const data = await api(`/api/journeys/calendar?from=${from}&to=${to}`);
      entries = data.entries || [];
      draftDates = data.draft_dates || [];
    }
    const listed = calendarState.day && !calendarState.search && !calendarState.tab
      ? entries.filter((entry) => entry.start_date <= calendarState.day && entry.end_date >= calendarState.day)
      : entries;
    const [y, m] = calendarState.month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const lead = new Date(y, m - 1, 1).getDay();
    const days = [];
    for (let i = 0; i < lead; i += 1) days.push({ id: `blank-${i}`, day: 0, action: '' });
    for (let d = 1; d <= daysInMonth; d += 1) {
      const date = `${calendarState.month}-${String(d).padStart(2, '0')}`;
      const count = entries.filter((entry) => entry.start_date <= date && entry.end_date >= date).length;
      const dayAction = action(String(d), async () => {
        calendarState.day = calendarState.day === date ? '' : date;
        return { page: await calendarPage() };
      });
      days.push({ id: date, day: d, count, draft: draftDates.includes(date), selected: calendarState.day === date, action: dayAction.id });
    }
    const prevMonth = action(t('journey:calendar.prevMonth'), async () => {
      calendarState.month = shiftMonth(calendarState.month, -1);
      calendarState.day = '';
      return { page: await calendarPage() };
    });
    const nextMonth = action(t('journey:calendar.nextMonth'), async () => {
      calendarState.month = shiftMonth(calendarState.month, 1);
      calendarState.day = '';
      return { page: await calendarPage() };
    });
    const rows = listed.map((entry) => ({
      id: String(entry.id),
      title: entry.title,
      subtitle: tx('journey:calendar.entryMeta', {
        range: formatRange(entry.start_date, entry.end_date),
        stop_count: entry.stop_count,
        extra: entry.places?.length ? ` · ${entry.places.join(t('common:punctuation.listSeparator'))}` : ''
      }),
      badge: entry.visibility === 'public' ? t('journey:common.label.public') : t('journey:common.label.private'),
      badgeTone: entry.visibility === 'public' ? 'primary' : '',
      protectedImage: entry.cover_media_id ? `journey:${entry.cover_media_id}` : '',
        actions: [
        action(t('journey:common.feature.diary'), async () => ({ page: await go('detail', { journeyId: entry.id }) })),
        action(t('common:action.delete'), async () => {
          await api(`/api/journeys/${encodeURIComponent(entry.id)}`, { method: 'DELETE', body: JSON.stringify({ base_revision: entry.revision }) });
          return { page: await calendarPage(), message: t('journey:calendar.deleted', { count: 1 }) };
        }, { tone: 'danger', confirm: { title: t('common:action.delete'), message: t('journey:calendar.confirmDelete', { count: 1, publicCount: '' }), button: t('common:action.delete') } })
      ]
    }));
    const sections = [
      {
        id: 'calendar',
        title: '',
        calendar: {
          monthLabel: t('journey:calendar.listTitle', { range: `${y}-${String(m).padStart(2, '0')}` }) || calendarState.month,
          weekdays: [
            t('journey:calendar.week.sun'), t('journey:calendar.week.mon'), t('journey:calendar.week.tue'),
            t('journey:calendar.week.wed'), t('journey:calendar.week.thu'), t('journey:calendar.week.fri'),
            t('journey:calendar.week.sat')
          ],
          days,
          prev: prevMonth.id,
          next: nextMonth.id
        }
      }
    ];
    if (rows.length) sections.push({ id: 'entries', title: calendarState.day || calendarState.month, rows });
    const buttons = [
      action(t('journey:calendar.unfinished', { badge: '' }), async () => ({ page: await go('unfinished', {}) })),
      action(t('journey:common.feature.privateImages'), async () => ({ page: await go('media', {}) })),
      action(t('journey:common.feature.generate'), async () => ({ page: await go('composer', { preset: calendarState.day ? { date: calendarState.day } : undefined }) }), { tone: 'primary' }),
      action(t('journey:calendar.createManually'), async () => ({ page: await go('review', { date: calendarState.day || today() }) })),
      action(t('common:action.refresh'), async () => ({ page: await calendarPage() }))
    ];
    return basePage('journey-calendar', t('journey:common.feature.calendar'), {
      subtitle: formatRange(calendarState.day || `${calendarState.month}-01`, calendarState.day || undefined),
      searchPlaceholder: t('journey:calendar.searchPlaceholder'),
      searchValue: calendarState.search,
      tabs: [
        { id: '', title: t('journey:calendar.filterAll') },
        { id: 'public', title: t('journey:common.label.public') },
        { id: 'private', title: t('journey:common.label.private') }
      ],
      selectedTab: calendarState.tab,
      sections,
      empty: t('journey:calendar.emptyMonthTitle'),
      buttons
    });
  }

  // ---- 详情 ----
  async function detailPage(params) {
    const journey = await api(`/api/journeys/${encodeURIComponent(params.journeyId)}`);
    const document = journey.document;
    const publicInfo = journey.publication;
    const sections = [];
    if (params.message) sections.push({ id: 'message', title: '', text: params.message });
    sections.push({
      id: 'header',
      title: document.title,
      text: [formatRange(document.start_date, document.end_date), t('journey:detail.meta', { range: '', count: document.stops?.length || 0 }), journey.visibility === 'public' ? t('journey:detail.published') : t('journey:detail.privateOnly')].filter(Boolean).join(' · ')
    });
    if (document.summary) sections.push({ id: 'summary', title: '', text: document.summary });
    if (document.stops?.length) {
      sections.push({
        id: 'stops',
        title: t('journey:common.feature.diary'),
        rows: document.stops.map((stop, index) => ({
          id: stop.id,
          title: `${index + 1}. ${stop.name}`,
          subtitle: [stop.at || '', stop.address || ''].filter(Boolean).join(' · '),
          detail: excerptText(stop),
          actions: stop.place_id && onOpenPlace ? [action(t('journey:detail.viewMarker'), async () => {
            onOpenPlace(String(stop.place_id));
            return { close: true };
          })] : []
        }))
      });
    }
    if (document.entry_media_ids?.length) {
      sections.push({
        id: 'photos',
        title: t('journey:detail.photosTitle', { count: document.entry_media_ids.length }),
        images: document.entry_media_ids.map((id) => ({ id, caption: '', protectedImage: `journey:${id}`, actions: [] }))
      });
    }
    const buttons = [
      action(t('journey:detail.edit'), async () => ({ page: await go('review', { journeyId: journey.id }) }), { tone: 'primary' }),
      action(t('journey:common.action.generateShare'), async () => ({ page: await go('share', { journeyId: journey.id }) })),
      action(t('journey:detail.viewOnMap'), async () => {
        onShowMap?.(journey);
        return { close: true };
      }),
      action(t('journey:detail.history'), async () => {
        const revisions = await api(`/api/journeys/${encodeURIComponent(journey.id)}/revisions`);
        const page = await go('detail', { journeyId: journey.id });
        page.sections.push({
          id: 'revisions',
          title: t('journey:detail.history'),
          rows: revisions.map((revision) => ({
            id: String(revision.revision),
            title: tx('journey:detail.revisionLabel', { revision: revision.revision, time: String(revision.created_at || '').slice(0, 16).replace('T', ' '), current: revision.revision === journey.revision ? t('journey:detail.current') : '' }),
            actions: [action(t('journey:detail.history'), async () => {
              await api(`/api/journeys/${encodeURIComponent(journey.id)}/restore`, {
                method: 'POST',
                body: JSON.stringify({ revision: revision.revision, base_revision: journey.revision })
              });
              return { page: await go('detail', { journeyId: journey.id, message: t('journey:detail.restoredPrivate') }) };
            }, { confirm: { title: t('journey:detail.history'), message: t('journey:detail.confirmRestore', { revision: revision.revision }), button: t('journey:detail.history') } })]
          }))
        });
        return { page };
      }),
      action(t('journey:detail.saveCopy'), async () => {
        const copy = await api('/api/journeys', { method: 'POST', body: JSON.stringify({ document }) });
        return { page: await go('detail', { journeyId: copy.id, message: t('journey:detail.copySaved') }) };
      })
    ];
    if (journey.visibility === 'public' && publicInfo?.public_id) {
      buttons.push(action(t('journey:detail.copyPublicLink'), async () => {
        const ok = await copyText(buildPublicUrl(`/?diary=${encodeURIComponent(publicInfo.public_id)}`));
        return { message: ok ? t('journey:detail.linkCopied') : t('journey:detail.copyFailed') };
      }));
    }
    buttons.push(action(t('journey:detail.deleteDiary'), async () => {
      await api(`/api/journeys/${encodeURIComponent(journey.id)}`, { method: 'DELETE', body: JSON.stringify({ base_revision: journey.revision }) });
      stack = stack.filter((item) => item.type !== 'detail');
      return { page: await calendarPage(), message: t('journey:detail.deleted') };
    }, { tone: 'danger', confirm: { title: t('journey:detail.deleteDiary'), message: t('journey:detail.confirmDelete'), button: t('journey:detail.deleteDiary') } }));
    return basePage('journey-detail', t('journey:common.feature.diary'), {
      subtitle: formatRange(document.start_date, document.end_date),
      sections,
      buttons
    });
  }

  // ---- 未完成 ----
  async function unfinishedPage() {
    const sections = [];
    const buttons = [];
    let data = null;
    try { data = await api('/api/journeys/unfinished'); } catch (error) { sections.push({ id: 'error', title: '', text: error.message }); }
    if (data) {
      const group = (title, items, buildRow) => {
        if (!items?.length) return;
        sections.push({ id: `group-${title}`, title: `${title} · ${items.length}`, rows: items.map(buildRow) });
      };
      group(t('journey:unfinished.section.material'), data.material || [], (item) => ({
        id: String(item.id),
        title: item.title,
        subtitle: t('journey:unfinished.materialMeta', {
          range: item.start_date ? formatRange(item.start_date) : t('journey:unfinished.noDate'),
          media_count: item.media_count,
          newer: '',
          lastError: ''
        }),
        actions: [
          action(t('journey:unfinished.continue'), async () => ({ page: await go('composer', { composeId: item.id }) })),
          action(t('common:action.delete'), async () => {
            await api(`/api/journeys/compose-drafts/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: item.revision }) });
            return { page: await unfinishedPage() };
          }, { tone: 'danger', confirm: { title: t('common:action.delete'), message: t('journey:unfinished.confirmDiscard', { label: item.title }), button: t('common:action.delete') } })
        ]
      }));
      group(t('journey:unfinished.section.generating'), data.generating || [], (item) => ({
        id: String(item.id),
        title: item.title,
        subtitle: item.job_status === 'queued' ? t('journey:unfinished.queued') : t('journey:unfinished.section.generating'),
        actions: [action(t('journey:unfinished.view'), async () => ({ page: await go('generation', { composeId: item.id, jobId: item.job_id }) }))]
      }));
      group(t('journey:unfinished.section.review'), data.review || [], (item) => ({
        id: String(item.id),
        title: item.title,
        subtitle: t('journey:unfinished.reviewMeta', { range: formatRange(item.start_date, item.end_date), stop_count: item.stop_count, pending: item.pending ? t('journey:unfinished.reviewPending', { pending: item.pending }) : '' }),
        actions: [action(t('journey:unfinished.continueReview'), async () => ({ page: await go('review', { draftId: item.id }) }))]
      }));
      group(t('journey:unfinished.section.editing'), data.editing || [], (item) => ({
        id: String(item.id),
        title: item.title,
        subtitle: `${formatRange(item.start_date, item.end_date)}${item.journey_id ? t('journey:unfinished.editingExisting') : t('journey:unfinished.editingNew')}`,
        actions: [action(t('journey:unfinished.continueEditing'), async () => ({ page: await go('review', { draftId: item.id }) }))]
      }));
    }
    const localEditor = userId ? await loadLocalDraft(userId, 'active').catch(() => null) : null;
    if (localEditor && !localEditor.synced && localEditor.journal) {
      sections.unshift({
        id: 'local-editor',
        title: t('journey:unfinished.localLabel'),
        rows: [{
          id: 'local',
          title: localEditor.journal.document?.title || t('journey:unfinished.untitledDiary'),
          subtitle: t('journey:unfinished.savedAt', { time: new Date(localEditor.updatedAt).toLocaleString() }),
          actions: [
            action(t('journey:unfinished.restore'), async () => {
              review = null;
              return { page: await go('review', { journal: localEditor.journal }) };
            }),
            action(t('common:action.delete'), async () => {
              await deleteLocalDraft(userId, 'active');
              return { page: await unfinishedPage() };
            }, { tone: 'danger', confirm: { title: t('common:action.delete'), message: t('journey:unfinished.confirmDiscard', { label: t('journey:unfinished.discard.localEdits') }), button: t('common:action.delete') } })
          ]
        }]
      });
    }
    buttons.push(action(t('journey:calendar.createManually'), async () => ({ page: await go('review', { date: today() }) })));
    buttons.push(action(t('journey:common.feature.generate'), async () => ({ page: await go('composer', {}) })));
    return basePage('journey-unfinished', t('journey:unfinished.title', { total: '' }), {
      sections,
      empty: t('journey:unfinished.emptyTitle'),
      buttons
    });
  }

  // ---- 私人图片空间 ----
  async function mediaPage() {
    const media = await api('/api/journeys/media');
    const used = (media || []).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    const images = (media || []).map((item) => ({
      id: String(item.id),
      caption: '',
      protectedImage: `journey:${item.id}`,
      actions: [action(t('common:action.delete'), async () => {
        await api(`/api/journeys/media/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        return { page: await mediaPage(), message: t('journey:unfinished.media.deleteLabel') };
      }, { tone: 'danger', confirm: { title: t('common:action.delete'), message: t('journey:unfinished.media.confirmDelete'), button: t('common:action.delete') } })]
    }));
    return basePage('journey-media', t('journey:common.feature.privateImages'), {
      subtitle: tx('journey:unfinished.media.usage', { summary: media ? t('journey:unfinished.media.summary', { count: media.length, used: (used / 1024 / 1024).toFixed(1) }) : '' }),
      sections: images.length ? [{ id: 'media', title: '', images }] : [],
      empty: t('journey:unfinished.media.empty'),
      buttons: [action(t('common:action.refresh'), async () => ({ page: await mediaPage() }))]
    });
  }

  // ---- 公开日记 ----
  async function publicPage(params) {
    const journey = await api(`/api/public/journeys/${encodeURIComponent(params.publicId)}`);
    const sections = [{
      id: 'header',
      title: journey.title,
      text: [journey.author?.username || '', formatRange(journey.start_date, journey.end_date), tx('journey:public.meta', { range: '', count: journey.stops?.length || 0 })].filter(Boolean).join(' · ')
    }];
    if (journey.summary) sections.push({ id: 'summary', title: '', text: journey.summary });
    if (journey.text) sections.push({ id: 'text', title: '', text: journey.text });
    if (journey.entry_media_ids?.length) {
      sections.push({
        id: 'photos',
        title: t('journey:public.entryPhoto'),
        images: journey.entry_media_ids.map((id) => ({
          id,
          caption: '',
          image: `${backendUrl}/api/public/journeys/${encodeURIComponent(journey.public_id)}/media/${encodeURIComponent(id)}`,
          actions: []
        }))
      });
    }
    if (journey.stops?.length) {
      sections.push({
        id: 'stops',
        title: t('journey:common.feature.diary'),
        rows: journey.stops.map((stop, index) => ({
          id: String(stop.id),
          title: `${index + 1}. ${stop.name}`,
          subtitle: stop.at || '',
          detail: (stop.excerpt || []).map((item) => item.text).join('\n'),
          badge: stop.unverified ? t('journey:public.unverified') : '',
          badgeTone: stop.unverified ? 'warning' : '',
          actions: stop.place_id && onOpenPlace ? [action(t('journey:public.viewMarker'), async () => { onOpenPlace(String(stop.place_id)); return { close: true }; })] : []
        }))
      });
    }
    const buttons = [
      action(t('journey:public.copyLink'), async () => {
        const ok = await copyText(buildPublicUrl(`/?diary=${encodeURIComponent(journey.public_id)}`));
        return { message: ok ? t('journey:public.linkCopied') : t('journey:public.copyLink') };
      }),
      action(t('journey:public.report'), async () => {
        onOpenFeedback?.(diaryReportPrefill(journey));
        return { close: true };
      }, { tone: 'danger' })
    ];
    return basePage('journey-public', t('journey:common.feature.diary'), { sections, buttons });
  }

  // ---- 同好 ----
  async function loadCommunity() {
    if (community) return community;
    const [consent, collections, favorites, neighbors, feedback] = await Promise.all([
      api('/api/community/consent'),
      api('/api/community/collections'),
      api('/api/favorites'),
      api('/api/community/neighbors'),
      api('/api/community/feedback')
    ]);
    community = {
      consent,
      collections: collections || [],
      favorites: favorites || [],
      neighbors: neighbors || {},
      feedback: feedback || {},
      section: 'neighbors',
      person: null,
      researchChoice: false
    };
    return community;
  }

  async function communityPage(params) {
    const state = await loadCommunity();
    if (params.section) state.section = params.section;
    const tabs = [
      { id: 'neighbors', title: t('journey:common.feature.community') },
      { id: 'collections', title: t('journey:community.tab.collections') },
      { id: 'settings', title: t('journey:community.tab.settings') }
    ];
    const sections = [];
    if (state.section === 'neighbors') {
      const list = state.neighbors?.neighbors || [];
      if (list.length) {
        sections.push({
          id: 'neighbors',
          title: state.neighbors.notice || '',
          rows: list.map((person) => ({
            id: String(person.id),
            title: person.username,
            subtitle: tx('journey:community.neighborMeta', {
              similarity: Math.round(person.similarity * 100),
              confidence: person.confidence,
              value: person.shared?.length ? ` · ${person.shared.join(' · ')}` : ''
            }),
            actions: [action(t('journey:community.viewCollection', { username: person.username }), async () => {
              const data = await api(`/api/community/users/${encodeURIComponent(person.id)}/collections`);
              state.person = { ...data, similarity: person.similarity, shared: person.shared };
              return { page: await communityPage({ section: 'neighbors' }) };
            })]
          }))
        });
      } else {
        sections.push({ id: 'neighbors-empty', title: '', text: state.neighbors?.profile_status === 'disabled' ? t('journey:community.empty.disabledHint') : t('journey:community.empty.notEnoughHint') });
      }
      if (state.person) {
        const placeRows = [];
        (state.person.collections || []).forEach((collection) => {
          (collection.places || []).forEach((place) => {
            placeRows.push({
              id: `${collection.id}-${place.id}`,
              title: place.name,
              subtitle: `${collection.title} · ${place.category || t('common:label.uncategorized')}`,
              actions: onOpenPlace ? [action(t('journey:common.feature.diary'), async () => { onOpenPlace(String(place.id)); return { close: true }; })] : []
            });
          });
        });
        sections.push({
          id: 'person',
          title: tx('journey:community.collectionOf', { username: state.person.user?.username || '' }),
          rows: placeRows.length ? placeRows : [{ id: 'empty', title: t('journey:community.noPublicCollections'), actions: [] }]
        });
      }
    } else if (state.section === 'collections') {
      const rows = (state.collections || []).map((collection) => ({
        id: String(collection.id),
        title: collection.title,
        subtitle: collection.is_public ? t('journey:common.label.public') : t('journey:common.label.private'),
        badge: collection.places?.length ? String(collection.places.length) : '',
        actions: [
          formAction(t('journey:community.saveCollection'), () => registerForm({
            title: collection.title,
            submitTitle: t('journey:community.saveCollection'),
            openTitle: t('common:action.edit'),
            fields: [
              { id: 'title', kind: 'text', label: t('journey:community.collectionNameLabel'), value: collection.title },
              { id: 'is_public', kind: 'toggle', label: t('journey:community.makePublic'), value: !!collection.is_public },
              { id: 'places', kind: 'multiselect', label: t('journey:community.tab.collections'), value: (collection.places || []).map((place) => String(place.id)), options: (state.favorites || []).map((favorite) => ({ id: String(Number(favorite.place_id || favorite.id)), title: favorite.name })) }
            ],
            handler: async (values) => {
              const placeIds = (values.places || []).map(Number);
              const places = placeIds.map((id) => {
                const favorite = (state.favorites || []).find((item) => Number(item.place_id || item.id) === id);
                return favorite ? { id, name: favorite.name } : { id, name: String(id) };
              });
              await api(`/api/community/collections/${encodeURIComponent(collection.id)}`, {
                method: 'PUT',
                body: JSON.stringify({ ...collection, title: String(values.title || '').trim() || collection.title, is_public: !!values.is_public, place_ids: placeIds, places })
              });
              community = null;
              return { page: await communityPage({ section: 'collections' }), message: t('journey:community.collectionSaved') };
            }
          })),
          action(t('common:action.delete'), async () => {
            await api(`/api/community/collections/${encodeURIComponent(collection.id)}`, { method: 'DELETE' });
            community = null;
            return { page: await communityPage({ section: 'collections' }) };
          }, { tone: 'danger', confirm: { title: t('common:action.delete'), message: t('journey:community.confirmDeleteCollection', { title: collection.title }), button: t('common:action.delete') } })
        ]
      }));
      sections.push({ id: 'collections', title: t('journey:community.collectionsHint'), rows });
    } else {
      const consent = state.consent || {};
      const form = registerForm({
        title: t('journey:community.tab.settings'),
        message: t('journey:community.settingsHint'),
        submitTitle: t('journey:community.saveSettings'),
        openTitle: t('common:action.edit'),
        fields: [
          { id: 'tags', kind: 'text', label: t('journey:community.tagsLabel'), value: (consent.tags || []).join(t('journey:community.tagSeparator')) },
          { id: 'discovery', kind: 'toggle', label: t('journey:community.consent.discovery'), value: !!consent.discovery },
          { id: 'feedback', kind: 'toggle', label: t('journey:community.consent.feedback'), value: !!consent.feedback },
          { id: 'research', kind: 'toggle', label: t('journey:community.consent.research'), value: !!consent.research }
        ],
        handler: async (values) => {
          const next = {
            ...consent,
            tags: String(values.tags || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean),
            discovery: !!values.discovery,
            feedback: !!values.feedback,
            research: !!values.research
          };
          await api('/api/community/consent', { method: 'PUT', body: JSON.stringify({ ...next, research_choice: !!values.research }) });
          community = null;
          return { page: await communityPage({ section: 'settings' }), message: t('journey:community.settingsSaved') };
        }
      });
      sections.push({ id: 'settings', title: '', form });
      const stats = (state.feedback?.counts || []).map((item) => `${item.kind} ${item.count}`).join(' · ');
      sections.push({ id: 'stats', title: t('journey:community.tab.settings'), text: stats || t('journey:community.noInteractions') });
    }
    const buttons = [
      action(t('common:action.refresh'), async () => { community = null; return { page: await communityPage({ section: state.section }) }; })
    ];
    if (state.section === 'neighbors' && state.person && onOpenFeedback) {
      buttons.push(action(t('journey:community.report'), async () => {
        onOpenFeedback(userReportPrefill(state.person.user));
        return { close: true };
      }, { tone: 'danger' }));
    }
    if (state.section === 'collections') {
      buttons.push(action(t('journey:community.newCollection'), async () => {
        await api('/api/community/collections', { method: 'POST', body: JSON.stringify({ title: t('journey:community.newCollectionName') }) });
        community = null;
        return { page: await communityPage({ section: 'collections' }) };
      }));
    }
    if (state.section === 'settings') {
      buttons.push(action(t('journey:community.clearInteractions'), async () => {
        await api('/api/community/feedback', { method: 'DELETE' });
        community = null;
        return { page: await communityPage({ section: 'settings' }), message: t('journey:community.interactionsCleared') };
      }, { tone: 'danger', confirm: { title: t('journey:community.clearInteractions'), message: t('journey:community.settingsHint'), button: t('journey:community.clearInteractions') } }));
    }
    return basePage('journey-community', t('journey:common.feature.community'), {
      tabs,
      selectedTab: state.section,
      sections,
      buttons
    });
  }

  // ---- 分享设置 ----
  async function sharePage(params) {
    const journey = await api(`/api/journeys/${encodeURIComponent(params.journeyId)}`);
    const visited = (journey.document?.stops || []).filter((stop) => stop.confirmed && stop.visit_status === 'visited');
    const platformOptions = [
      { id: t('journey:share.platformOption.xiaohongshu'), title: t('journey:share.platformOption.xiaohongshu') },
      { id: t('journey:share.platformOption.moments'), title: t('journey:share.platformOption.moments') },
      { id: t('journey:share.platformOption.journal'), title: t('journey:share.platformOption.journal') },
      { id: t('journey:share.platformOption.diary'), title: t('journey:share.platformOption.diary') }
    ];
    const styleOptions = [
      { id: t('journey:share.styleOption.natural'), title: t('journey:share.styleOption.natural') },
      { id: t('journey:share.styleOption.lively'), title: t('journey:share.styleOption.lively') },
      { id: t('journey:share.styleOption.concise'), title: t('journey:share.styleOption.concise') },
      { id: t('journey:share.styleOption.literary'), title: t('journey:share.styleOption.literary') }
    ];
    const options = share?.journeyId === params.journeyId ? share.options : {
      platform: platformOptions[0].id,
      style: styleOptions[0].id,
      min: 100,
      max: 500,
      include_notes: false,
      include_expenses: false,
      stop_ids: visited.map((stop) => stop.id)
    };
    const form = registerForm({
      title: t('journey:share.selectStops'),
      message: t('journey:share.nativeIntro'),
      submitTitle: t('journey:share.generate'),
      openTitle: t('common:action.edit'),
      fields: [
        { id: 'stop_ids', kind: 'multiselect', label: t('journey:share.selectStops'), value: options.stop_ids, options: visited.map((stop, index) => ({ id: stop.id, title: `${index + 1}. ${stop.name}` })) },
        { id: 'include_notes', kind: 'toggle', label: t('journey:share.includeNotes'), value: !!options.include_notes },
        { id: 'include_expenses', kind: 'toggle', label: t('journey:share.includeExpenses'), value: !!options.include_expenses },
        { id: 'platform', kind: 'select', label: t('journey:share.platform'), value: options.platform, options: platformOptions },
        { id: 'style', kind: 'select', label: t('journey:share.style'), value: options.style, options: styleOptions },
        { id: 'min', kind: 'number', label: t('journey:share.minChars'), value: options.min },
        { id: 'max', kind: 'number', label: t('journey:share.maxChars'), value: options.max }
      ],
      handler: async (values) => {
        const next = {
          platform: values.platform || platformOptions[0].id,
          style: values.style || styleOptions[0].id,
          min: Number(values.min) || 100,
          max: Number(values.max) || 500,
          include_notes: !!values.include_notes,
          include_expenses: !!values.include_expenses,
          stop_ids: values.stop_ids || []
        };
        const data = await api(`/api/journeys/${encodeURIComponent(params.journeyId)}/share`, {
          method: 'POST',
          body: JSON.stringify({ ...next, base_revision: journey.revision })
        });
        share = { journeyId: params.journeyId, options: next, text: data.text };
        return { page: await sharePage({ journeyId: params.journeyId }), message: t('journey:share.generate') };
      }
    });
    const sections = [{ id: 'share-form', title: '', form }];
    if (share?.journeyId === params.journeyId && share.text) {
      sections.push({ id: 'share-text', title: t('journey:share.postSection'), text: share.text });
    }
    const buttons = [
      action(t('journey:share.openWebEditor'), async () => {
        onOpenShare?.(params.journeyId);
        return { close: true };
      }, { tone: 'primary' })
    ];
    return basePage('journey-share', t('journey:common.action.generateShare'), {
      subtitle: t('journey:share.nativeIntro'),
      sections,
      buttons
    });
  }

  // ---- 事件入口 ----
  async function handle(type, payload = {}) {
    try {
      if (type === 'back') {
        if (stack[stack.length - 1]?.type === 'review' && review) {
          try {
            await persistReviewDraft();
          } catch (error) {
            if (userId) {
              try {
                await saveLocalDraft(userId, 'active', {
                  journal: { id: review.journeyId, revision: review.baseRevision, document: review.document },
                  serverDraftId: review.draftId,
                  serverRevision: review.draftRevision,
                  synced: false
                });
              } catch { /* 本机也写不了时只能放弃 */ }
            }
          }
        }
        return { page: await back() };
      }
      if (type === 'action') {
        const actionId = String(payload.actionId || '');
        const run = actions.get(actionId);
        if (!run) return { error: t('journey:feedback.requestFailed', { status: 400 }) };
        return await run(payload) || {};
      }
      if (type === 'filter') {
        const top = stack[stack.length - 1];
        if (top?.type === 'community' && payload.filterId === 'tabs') {
          const value = String(payload.value || 'neighbors');
          if (community) community.section = value;
          return { page: await communityPage({ section: value }) };
        }
        if (top?.type !== 'calendar') return {};
        if (payload.filterId === 'search') {
          calendarState.search = String(payload.value || '');
          calendarState.day = '';
        } else if (payload.filterId === 'tabs') {
          calendarState.tab = String(payload.value || '');
          calendarState.day = '';
        }
        return { page: await calendarPage() };
      }
      if (type === 'submit') {
        const run = forms.get(String(payload.formId || ''));
        if (!run) return { error: t('journey:feedback.requestFailed', { status: 400 }) };
        return await run(payload.values || {}) || {};
      }
      return {};
    } catch (error) {
      return { error: error?.message || t('journey:feedback.requestFailed', { status: 500 }) };
    }
  }

  async function loadImage(imageId) {
    try {
      const id = String(imageId);
      if (id.startsWith('journey:')) {
        const mediaId = id.slice('journey:'.length);
        const res = await fetch(`${backendUrl}/api/journeys/media/${encodeURIComponent(mediaId)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(String(res.status));
        return { ok: true, imageId: id, imageData: await blobToBase64(await res.blob()) };
      }
      return { ok: false, imageId: id };
    } catch (error) {
      return { ok: false, imageId, message: error?.message || '' };
    }
  }

  function close() {
    clearTimers();
    onClose?.();
  }

  return {
    start: entryPage,
    handle,
    loadImage,
    close
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
