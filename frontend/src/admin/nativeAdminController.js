// 管理后台原生页的网页侧控制器：按权限和面板整理页面模型，所有请求仍由网页携带凭证执行。
// 原生只显示 rows / form / calendar / images，并把动作、筛选与表单值回传这里。
import { t } from '../i18n/index.js';
import { NOTICE_COLOR_OPTIONS } from '../components/feedback/noticeColors.js';
import { feedbackTypeLabel } from '../feedback/feedbackTypes.js';
import { TASTE_AXES, axisLabel } from '../profile/tasteAxes.js';
import { getSkin } from '../skins/registry.js';
import { copyText } from '../platform/share.js';

const PAGE_SIZE = 10;
const QQ_PATTERN = /^\d{5,15}$/;

// 文案键写成字面量，i18n 检查才能覆盖
const SECTION_TITLES = {
  users: () => t('admin:dashboard.sections.users'),
  generalUsers: () => t('admin:dashboard.sections.generalUsers'),
  places: () => t('admin:dashboard.sections.places'),
  tasteAxes: () => t('admin:dashboard.sections.tasteAxes'),
  qqWhitelist: () => t('admin:dashboard.sections.qqWhitelist'),
  notices: () => t('admin:dashboard.sections.notices'),
  exhibitions: () => t('admin:dashboard.sections.exhibitions'),
  skinCodes: () => t('admin:dashboard.sections.skinCodes'),
  feedback: () => t('admin:dashboard.sections.feedback'),
  audit: () => t('admin:auditModal.title')
};
const SKIN_STATUS = {
  active: () => t('admin:skinCodes.status.active'),
  exhausted: () => t('admin:skinCodes.status.exhausted'),
  expired: () => t('admin:skinCodes.status.expired'),
  revoked: () => t('admin:skinCodes.status.revoked')
};

function sectionPermissions(level) {
  if (level === 'YUYUKO') return ['users', 'places', 'tasteAxes', 'qqWhitelist', 'notices', 'exhibitions', 'skinCodes', 'feedback', 'audit'];
  if (level === 'YOUMU') return ['generalUsers', 'places', 'tasteAxes', 'qqWhitelist', 'notices', 'exhibitions', 'feedback', 'audit'];
  return ['generalUsers', 'places', 'tasteAxes', 'feedback', 'audit'];
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function statusLabel(banned) {
  return banned ? t('admin:users.statusBanned') : t('admin:users.statusNormal');
}

function pageSummary(count, page, totalPages) {
  return t('admin:common.pagination.summary', { count, page, totalPages });
}

function searchMatch(query, ...values) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return values.some((value) => String(value ?? '').toLowerCase().includes(q));
}

function detailLines(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  return Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined && item !== '')
    .slice(0, 8)
    .map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : item}`)
    .join('\n');
}

/**
 * 控制器：dashboard 为根页；各面板按需加载。动作/表单处理器在每次构建页面时注册，
 * 原生只回传 id，避免把任意 URL 或账号操作交给原生。
 */
export function createNativeAdminController({ backendUrl, token, user, onRequireAuth, onOpenPlace }) {
  const level = user?.admin_level || null;
  const actions = new Map();
  const forms = new Map();
  const states = new Map();
  let actionSeq = 0;
  let formSeq = 0;
  let section = null;

  async function api(path, options = {}) {
    const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers };
    const res = await fetch(`${backendUrl}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) onRequireAuth?.();
      throw new Error(data.error || t('admin:common.error.serverStatusDetail', { status: res.status, txt: '' }));
    }
    return data;
  }

  function action(title, run, options = {}) {
    const id = `a${++actionSeq}`;
    actions.set(id, run);
    const result = { id, title, tone: options.tone || '' };
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
      openTitle: openTitle || t('common:action.edit'),
      cancelTitle: t('common:action.cancel'),
      fields
    };
  }

  function formAction(title, build) {
    const id = `a${++actionSeq}`;
    actions.set(id, async () => ({ form: build() }));
    return { id, title };
  }

  function stateFor(id) {
    if (!states.has(id)) states.set(id, { search: '', tab: '', page: 1 });
    return states.get(id);
  }

  function dashboardPage() {
    actions.clear();
    forms.clear();
    section = null;
    const sections = sectionPermissions(level);
    const rows = sections.map((id) => {
      const title = SECTION_TITLES[id]();
      return { id, title, subtitle: '', actions: [action(title, async () => ({ page: await load(id) }))] };
    });
    return {
      id: 'admin-dashboard',
      title: t('admin:dashboard.title'),
      subtitle: `${user?.username || ''} · ${level || t('admin:dashboard.regularUser')}`,
      canGoBack: false,
      closeTitle: t('common:action.close'),
      sections: rows.length ? [{ id: 'sections', title: '', rows }] : [],
      empty: t('admin:dashboard.notAdmin'),
      buttons: []
    };
  }

  async function load(id) {
    section = id;
    switch (id) {
      case 'users': return loadUsers();
      case 'generalUsers': return loadGeneralUsers();
      case 'places': return loadPlaces();
      case 'tasteAxes': return loadTasteAxes();
      case 'qqWhitelist': return loadQQWhitelist();
      case 'notices': return loadNotices();
      case 'exhibitions': return loadExhibitions();
      case 'skinCodes': return loadSkinCodes();
      case 'feedback': return loadFeedback();
      case 'audit': return loadAudit();
      default: return dashboardPage();
    }
  }

  function basePage(id, title, options = {}) {
    return {
      id: `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      subtitle: options.subtitle || '',
      canGoBack: true,
      closeTitle: t('common:action.close'),
      searchPlaceholder: options.searchPlaceholder || '',
      searchValue: options.searchValue || '',
      tabs: options.tabs || [],
      selectedTab: options.selectedTab || '',
      sections: options.sections || [],
      buttons: options.buttons || [],
      pagerText: options.pagerText || '',
      pagerPrev: options.pagerPrev || '',
      pagerNext: options.pagerNext || '',
      empty: options.empty || '',
      message: options.message || '',
      error: options.error || '',
      loading: !!options.loading,
      backTitle: t('common:action.back')
    };
  }

  function pager(state, totalPages, reload) {
    if (totalPages <= 1) return { pagerText: '', pagerPrev: '', pagerNext: '' };
    const prev = action(t('admin:common.pagination.prev'), async () => {
      state.page = Math.max(1, state.page - 1);
      return { page: await reload() };
    });
    const next = action(t('admin:common.pagination.next'), async () => {
      state.page = Math.min(totalPages, state.page + 1);
      return { page: await reload() };
    });
    const atStart = state.page <= 1;
    const atEnd = state.page >= totalPages;
    return {
      pagerText: pageSummary(state.total, state.page, totalPages),
      pagerPrev: atStart ? '' : prev.id,
      pagerNext: atEnd ? '' : next.id
    };
  }

  // ---- 用户 ----
  async function loadUsers() {
    actions.clear(); forms.clear();
    const state = stateFor('users');
    const users = await api('/admin/users');
    const filtered = (users || []).filter((u) => searchMatch(state.search, u.id, u.username, u.qq));
    state.total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const items = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const rows = items.map((u) => {
      const protectedTarget = u.id === user?.id || u.admin_level === 'YUYUKO';
      const levels = [['YUYUKO', t('admin:users.setYuyuko')], ['YOUMU', t('admin:users.setYoumu')], ['KOMACHI', t('admin:users.setKomachi')], ['', t('admin:users.setRegular')]]
        .filter(([value]) => (u.admin_level || '') !== value)
        .map(([value, label]) => protectedTarget ? null : action(label, async () => {
          await api('/admin/users/set-level', { method: 'POST', body: JSON.stringify({ userId: u.id, admin_level: value }) });
          return { page: await loadUsers(), message: t('admin:users.levelUpdated') };
        }, { confirm: { title: label, message: t('admin:users.confirmLevel', { username: u.username || u.id, oldLabel: u.admin_level || t('admin:users.regularUser'), nextLabel: value || t('admin:users.regularUser') }), button: label } })).filter(Boolean);
      const qqAction = formAction(t('admin:users.editQq'), () => registerForm({
        title: t('admin:qqModal.title', { username: u.username || u.id }),
        message: t('admin:qqModal.hint'),
        submitTitle: t('admin:qqModal.confirm'),
        fields: [{ id: 'qq', kind: 'text', label: t('admin:qqModal.label'), placeholder: t('admin:qqModal.placeholder'), value: u.qq || '', footer: t('admin:qqModal.hint') }],
        handler: async (values) => {
          const qq = String(values.qq || '').trim();
          if (qq && !QQ_PATTERN.test(qq)) return { error: t('admin:qqModal.invalid') };
          const data = await api('/admin/users/set-qq', { method: 'POST', body: JSON.stringify({ userId: u.id, qq }) });
          return { page: await loadUsers(), message: t('admin:users.qqUpdated'), data };
        }
      }));
      const banActions = protectedTarget ? [] : u.is_banned
        ? [action(t('admin:users.unban'), async () => {
          await api('/admin/users/unban', { method: 'POST', body: JSON.stringify({ userId: u.id }) });
          return { page: await loadUsers(), message: t('admin:users.unbanned') };
        }, { confirm: { title: t('admin:users.unban'), message: t('admin:users.confirmUnban', { username: u.username || u.id }) } })]
        : [formAction(t('admin:users.ban'), () => registerForm({
          title: t('admin:banModal.title', { username: u.username || u.id }),
          message: t('admin:banModal.effect'),
          submitTitle: t('admin:banModal.confirm'),
          fields: [
            { id: 'duration', kind: 'select', label: t('admin:banModal.duration'), value: '7', options: [
              { id: '1', title: t('admin:banModal.days1') },
              { id: '7', title: t('admin:banModal.days7') },
              { id: '30', title: t('admin:banModal.days30') },
              { id: 'perm', title: t('admin:banModal.permanent') }
            ] },
            { id: 'reason', kind: 'textarea', label: t('admin:banModal.reason'), placeholder: t('admin:banModal.reasonPlaceholder'), value: '' }
          ],
          handler: async (values) => {
            const duration = String(values.duration || '7');
            const body = { userId: u.id, reason: String(values.reason || '').trim() || null };
            if (duration !== 'perm') body.durationDays = Number(duration) || null;
            await api('/admin/users/ban', { method: 'POST', body: JSON.stringify(body) });
            return { page: await loadUsers(), message: t('admin:users.banned') };
          }
        }))];
      const deleteAction = protectedTarget ? [] : [action(t('admin:users.delete'), async () => {
        await api(`/admin/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' });
        return { page: await loadUsers(), message: t('admin:users.deleted') };
      }, { tone: 'danger', confirm: { title: t('admin:users.delete'), message: t('admin:users.confirmDelete', { username: u.username || u.id }), button: t('common:action.delete') } })];
      return {
        id: String(u.id),
        title: u.username || String(u.id),
        subtitle: [t('admin:users.idLine', { id: u.id }), u.qq ? `QQ ${u.qq}` : ''].filter(Boolean).join(' · '),
        detail: `${t('admin:users.level')}: ${u.admin_level || t('admin:users.regularUser')} · ${statusLabel(u.is_banned)}`,
        image: u.has_avatar ? `${backendUrl}/users/${encodeURIComponent(u.id)}/avatar?t=${Date.now()}` : '',
        badge: u.is_banned ? t('admin:users.statusBanned') : '',
        badgeTone: u.is_banned ? 'danger' : '',
        actions: [...levels, qqAction, ...banActions, ...deleteAction]
      };
    });
    const p = pager(state, totalPages, loadUsers);
    return basePage('admin-users', t('admin:users.title'), {
      subtitle: pageSummary(filtered.length, state.page, totalPages),
      searchPlaceholder: t('admin:users.searchPlaceholder'),
      searchValue: state.search,
      sections: rows.length ? [{ id: 'users', title: '', rows }] : [],
      empty: t('admin:users.noMatch'),
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadUsers() }))],
      ...p
    });
  }

  // ---- 普通用户 ----
  async function loadGeneralUsers() {
    actions.clear(); forms.clear();
    const state = stateFor('generalUsers');
    const users = await api('/admin/general-users');
    const filtered = (users || []).filter((u) => searchMatch(state.search, u.id, u.username, u.qq));
    const canBan = level === 'YOUMU';
    const rows = filtered.map((u) => {
      const ban = canBan ? (u.is_banned
        ? action(t('admin:users.unban'), async () => {
          await api('/admin/users/unban', { method: 'POST', body: JSON.stringify({ userId: u.id }) });
          return { page: await loadGeneralUsers(), message: t('admin:users.unbanned') };
        }, { confirm: { title: t('admin:users.unban'), message: t('admin:users.confirmUnban', { username: u.username || u.id }) } })
        : formAction(t('admin:users.ban'), () => registerForm({
          title: t('admin:banModal.title', { username: u.username || u.id }),
          message: t('admin:banModal.effect'),
          submitTitle: t('admin:banModal.confirm'),
          fields: [
            { id: 'duration', kind: 'select', label: t('admin:banModal.duration'), value: '7', options: [
              { id: '1', title: t('admin:banModal.days1') },
              { id: '7', title: t('admin:banModal.days7') },
              { id: '30', title: t('admin:banModal.days30') },
              { id: 'perm', title: t('admin:banModal.permanent') }
            ] },
            { id: 'reason', kind: 'textarea', label: t('admin:banModal.reason'), placeholder: t('admin:banModal.reasonPlaceholder'), value: '' }
          ],
          handler: async (values) => {
            const duration = String(values.duration || '7');
            const body = { userId: u.id, reason: String(values.reason || '').trim() || null };
            if (duration !== 'perm') body.durationDays = Number(duration) || null;
            await api('/admin/users/ban', { method: 'POST', body: JSON.stringify(body) });
            return { page: await loadGeneralUsers(), message: t('admin:users.banned') };
          }
        }))) : null;
      const remove = action(t('admin:generalUsers.deleteAction'), async () => {
        await api(`/admin/general-users/${encodeURIComponent(u.id)}`, { method: 'DELETE' });
        return { page: await loadGeneralUsers(), message: t('admin:generalUsers.deleted') };
      }, { tone: 'danger', confirm: { title: t('admin:generalUsers.deleteAction'), message: t('admin:generalUsers.confirmDelete', { username: u.username || u.id }), button: t('common:action.delete') } });
      return {
        id: String(u.id),
        title: u.username || String(u.id),
        subtitle: [t('admin:generalUsers.idLine', { id: u.id }), t('admin:generalUsers.qqLine', { qq: u.qq || '-' })].join(' · '),
        detail: statusLabel(u.is_banned),
        image: u.has_avatar ? `${backendUrl}/users/${encodeURIComponent(u.id)}/avatar?t=${Date.now()}` : '',
        badge: u.is_banned ? t('admin:users.statusBanned') : '',
        badgeTone: u.is_banned ? 'danger' : '',
        actions: [ban, remove].filter(Boolean)
      };
    });
    return basePage('admin-general-users', t('admin:generalUsers.title'), {
      subtitle: `${filtered.length}`,
      searchPlaceholder: t('admin:generalUsers.searchPlaceholder'),
      searchValue: state.search,
      sections: rows.length ? [{ id: 'general-users', title: '', rows }] : [],
      empty: t('admin:generalUsers.empty'),
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadGeneralUsers() }))]
    });
  }

  // ---- 地点申请 ----
  async function loadPlaces() {
    actions.clear(); forms.clear();
    const state = stateFor('places');
    const requests = await api('/place-requests');
    const pending = (requests || []).filter((r) => r && r.status === 'pending');
    const filtered = pending.filter((r) => searchMatch(state.search, r.id, r.place_id, r.requester_id, r.note, JSON.stringify(r.proposed || {})));
    state.total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const items = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const reasonLabels = {
      brief: t('admin:places.moderation.reason.brief'),
      unrelated: t('admin:places.moderation.reason.unrelated'),
      harmful: t('admin:places.moderation.reason.harmful'),
      image: t('admin:places.moderation.reason.image')
    };
    const rows = items.map((r) => {
      const isCreate = r.request_type === 'create';
      const reasons = (r.moderation?.decision?.reasons || []).map((reason) => reasonLabels[reason] || reason);
      const approveLabel = isCreate ? t('admin:places.createApproveAction') : t('admin:places.approveAction');
      const rejectLabel = isCreate ? t('admin:places.createRejectAction') : t('admin:places.rejectAction');
      const review = (actionValue, label, impact) => action(label, async () => {
        await api(`/place-requests/${encodeURIComponent(r.id)}/review`, { method: 'POST', body: JSON.stringify({ action: actionValue }) });
        return { page: await loadPlaces(), message: t('admin:places.success') };
      }, { tone: actionValue === 'reject' ? 'danger' : '', confirm: { title: label, message: t('admin:places.confirmReview', {
        action: actionValue === 'approve' ? t('admin:places.approve') : t('admin:places.reject'),
        id: r.id, place_id: r.place_id || '-', requester_id: r.requester_id || '-', impact
      }), button: label } });
      const detail = [
        isCreate ? t('admin:places.createMeta', { place_id: r.place_id || '-', creator: r.place?.creator_name || r.requester_id || '-' }) : t('admin:places.requestMeta', { place_id: r.place_id || '-', requester_id: r.requester_id || '-' }),
        reasons.length ? `${t('admin:places.moderation.label')}: ${reasons.join('、')}` : '',
        isCreate ? detailLines(r.place ? { name: r.place.name, category: r.place.category, address: r.place.address, cost: r.place.per_person_cost } : {}) : detailLines(r.proposed),
        r.note ? t('admin:places.requestNote', { note: r.note }) : ''
      ].filter(Boolean).join('\n');
      const imageUrl = isCreate && r.place ? firstPlaceImage(r.place, backendUrl) : '';
      const actions = [
        approveLabel ? review('approve', approveLabel, isCreate ? t('admin:places.createApproveImpact') : t('admin:places.approveImpact')) : null,
        review('reject', rejectLabel, isCreate ? t('admin:places.createRejectImpact') : t('admin:places.rejectImpact')),
        onOpenPlace && r.place_id ? action(t('admin:places.openOnMap'), async () => { onOpenPlace(r.place_id); return { close: true }; }) : null
      ].filter(Boolean);
      return {
        id: String(r.id),
        title: isCreate ? t('admin:places.createTitle', { id: r.id }) : t('admin:places.requestTitle', { id: r.id }),
        subtitle: r.created_time || '',
        detail,
        image: imageUrl,
        badge: isCreate ? t('admin:places.typeCreate') : '',
        badgeTone: isCreate ? 'warning' : '',
        actions
      };
    });
    const p = pager(state, totalPages, loadPlaces);
    return basePage('admin-places', t('admin:places.title'), {
      subtitle: t('admin:places.pageSummary', { count: filtered.length, page: state.page, totalPages }),
      searchPlaceholder: t('admin:places.searchPlaceholder'),
      searchValue: state.search,
      sections: rows.length ? [{ id: 'places', title: '', rows }] : [],
      empty: t('admin:places.empty'),
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadPlaces() }))],
      ...p
    });
  }

  // ---- 口味分类 ----
  async function loadTasteAxes() {
    actions.clear(); forms.clear();
    const state = stateFor('tasteAxes');
    if (!state.tab) state.tab = 'unknown';
    const query = new URLSearchParams({ filter: state.tab, page: String(state.page || 1) });
    if (state.search) query.set('q', state.search);
    const data = await api(`/admin/taste-axes/places?${query}`);
    const items = data.items || [];
    const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.page_size || 20)));
    state.total = data.total || 0;
    const sourceLabels = {
      unknown: t('admin:tasteAxes.source.unknown'),
      llm: t('admin:tasteAxes.source.llm'),
      manual: t('admin:tasteAxes.source.manual'),
      rule: t('admin:tasteAxes.source.rule')
    };
    const rows = items.map((item) => {
      const axesLabel = (item.axes || []).map(axisLabel);
      const edit = formAction(t('admin:tasteAxes.save'), () => registerForm({
        title: t('admin:tasteAxes.axesFor', { name: item.name }),
        message: t('admin:tasteAxes.intro'),
        submitTitle: t('admin:tasteAxes.save'),
        fields: [{ id: 'axes', kind: 'multiselect', label: t('admin:tasteAxes.title'), value: item.axes || [], options: TASTE_AXES.map((key) => ({ id: key, title: axisLabel(key) })) }],
        handler: async (values) => {
          await api(`/admin/taste-axes/places/${encodeURIComponent(item.place_id)}`, { method: 'PUT', body: JSON.stringify({ axes: values.axes || [] }) });
          return { page: await loadTasteAxes(), message: t('admin:tasteAxes.saved') };
        }
      }));
      const undo = item.source === 'manual' ? action(t('admin:tasteAxes.undo'), async () => {
        await api(`/admin/taste-axes/places/${encodeURIComponent(item.place_id)}`, { method: 'PUT', body: JSON.stringify({ axes: null }) });
        return { page: await loadTasteAxes(), message: t('admin:tasteAxes.reset') };
      }, { tone: 'danger', confirm: { title: t('admin:tasteAxes.undo'), message: t('admin:tasteAxes.intro'), button: t('admin:tasteAxes.undo') } }) : null;
      return {
        id: String(item.place_id),
        title: item.name,
        subtitle: `${item.category || t('admin:tasteAxes.noCategory')} · ${sourceLabels[item.source] || item.source}`,
        detail: axesLabel.length ? axesLabel.join(' · ') : t('admin:tasteAxes.empty'),
        actions: [edit, undo].filter(Boolean)
      };
    });
    const prev = action(t('admin:tasteAxes.prev'), async () => { state.page = Math.max(1, state.page - 1); return { page: await loadTasteAxes() }; });
    const next = action(t('admin:tasteAxes.next'), async () => { state.page = Math.min(totalPages, state.page + 1); return { page: await loadTasteAxes() }; });
    return basePage('admin-taste-axes', t('admin:tasteAxes.title'), {
      subtitle: t('admin:tasteAxes.intro'),
      searchPlaceholder: t('admin:tasteAxes.searchPlaceholder'),
      searchValue: state.search,
      tabs: [
        { id: 'unknown', title: t('admin:tasteAxes.filter.unknown') },
        { id: 'llm', title: t('admin:tasteAxes.filter.llm') },
        { id: 'manual', title: t('admin:tasteAxes.filter.manual') }
      ],
      selectedTab: state.tab,
      sections: rows.length ? [{ id: 'taste-axes', title: '', rows }] : [],
      empty: t('admin:tasteAxes.empty'),
      pagerText: t('admin:tasteAxes.page', { page: state.page, total: totalPages }),
      pagerPrev: state.page <= 1 ? '' : prev.id,
      pagerNext: state.page >= totalPages ? '' : next.id,
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadTasteAxes() }))]
    });
  }

  // ---- QQ 白名单 ----
  async function loadQQWhitelist() {
    actions.clear(); forms.clear();
    const state = stateFor('qqWhitelist');
    const entries = await api('/admin/qq-whitelist');
    const filtered = (entries || []).filter((entry) => searchMatch(state.search, entry.qq, entry.id));
    state.total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(filtered.length / 30));
    state.page = Math.min(state.page, totalPages);
    const items = filtered.slice((state.page - 1) * 30, state.page * 30);
    const rows = items.map((entry) => ({
      id: String(entry.id),
      title: String(entry.qq),
      subtitle: entry.created_time || '',
      detail: '',
      actions: [action(t('common:action.delete'), async () => {
        await api(`/admin/qq-whitelist/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
        return { page: await loadQQWhitelist(), message: t('admin:qqWhitelist.removed') };
      }, { tone: 'danger', confirm: { title: t('common:action.delete'), message: t('admin:qqWhitelist.confirmRemove'), button: t('common:action.delete') } })]
    }));
    const addForm = registerForm({
      title: t('admin:qqWhitelist.addTitle'),
      submitTitle: t('admin:qqWhitelist.add'),
      fields: [
        { id: 'single', kind: 'text', label: t('admin:qqWhitelist.singleLabel'), placeholder: t('admin:qqWhitelist.qqPlaceholder'), value: '' },
        { id: 'batch', kind: 'textarea', label: t('admin:qqWhitelist.batchLabel'), placeholder: '123456789\n987654321', value: '' }
      ],
      handler: async (values) => {
        const raw = String(values.batch || '').trim() || String(values.single || '').trim();
        if (!raw) return { error: t('admin:qqWhitelist.enterQQ') };
        const data = await api('/admin/qq-whitelist', { method: 'POST', body: JSON.stringify({ qq: raw }) });
        const parts = [];
        if (data.added?.length) parts.push(t('admin:qqWhitelist.addedSummary', { count: data.added.length, added: data.added.join(t('common:punctuation.listSeparator')) }));
        if (data.skipped?.length) parts.push(t('admin:qqWhitelist.skippedSummary', { count: data.skipped.length, details: data.skipped.map((s) => `${s.qq}(${s.reason})`).join(t('common:punctuation.listSeparator')) }));
        return { page: await loadQQWhitelist(), message: parts.join(t('admin:qqWhitelist.summarySeparator')) || t('admin:qqWhitelist.done') };
      }
    });
    const p = pager(state, totalPages, loadQQWhitelist);
    return basePage('admin-qq-whitelist', t('admin:qqWhitelist.title'), {
      subtitle: pageSummary(filtered.length, state.page, totalPages),
      searchPlaceholder: t('admin:qqWhitelist.searchPlaceholder'),
      searchValue: state.search,
      sections: [
        { id: 'qq-add', title: t('admin:qqWhitelist.addTitle'), form: addForm },
        ...(rows.length ? [{ id: 'qq-list', title: t('admin:qqWhitelist.title'), rows }] : [])
      ],
      empty: t('admin:qqWhitelist.empty'),
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadQQWhitelist() }))],
      ...p
    });
  }

  // ---- 公告 ----
  async function loadNotices() {
    actions.clear(); forms.clear();
    const notices = await api('/admin/notices');
    const current = (notices || []).find((item) => item && item.is_active) || null;
    const colorOptions = NOTICE_COLOR_OPTIONS.map((option) => ({ id: option.key, title: option.label }));
    const publishForm = registerForm({
      title: t('admin:notices.newTitle'),
      submitTitle: t('admin:notices.publish'),
      fields: [
        { id: 'title', kind: 'text', label: t('admin:notices.titlePlaceholder'), value: '', placeholder: t('admin:notices.titlePlaceholder') },
        { id: 'content', kind: 'textarea', label: t('admin:notices.contentPlaceholder'), value: '', placeholder: t('admin:notices.contentPlaceholder') },
        { id: 'color', kind: 'select', label: t('admin:notices.chooseColor'), value: colorOptions[0]?.id || '', options: colorOptions }
      ],
      handler: async (values) => {
        const title = String(values.title || '').trim();
        const content = String(values.content || '').trim();
        if (!title || !content) return { error: t('admin:notices.fillRequired') };
        await api('/admin/notices', { method: 'POST', body: JSON.stringify({ title, content, color_key: values.color }) });
        return { page: await loadNotices(), message: t('admin:notices.published') };
      }
    });
    const sections = [];
    if (current) {
      sections.push({ id: 'notice-current', title: t('admin:notices.currentTitle'), text: `${current.title}\n${current.content}` });
    } else {
      sections.push({ id: 'notice-current', title: t('admin:notices.currentTitle'), text: t('admin:notices.noCurrent') });
    }
    sections.push({ id: 'notice-form', title: '', form: publishForm });
    const buttons = [action(t('common:action.refresh'), async () => ({ page: await loadNotices() }))];
    if (current) {
      buttons.push(action(t('admin:notices.unpublish'), async () => {
        await api('/admin/notices/current', { method: 'DELETE' });
        return { page: await loadNotices(), message: t('admin:notices.unpublished') };
      }, { tone: 'danger', confirm: { title: t('admin:notices.unpublish'), message: t('admin:notices.confirmUnpublish'), button: t('admin:notices.unpublish') } }));
    }
    return basePage('admin-notices', t('admin:notices.title'), { sections, buttons });
  }

  // ---- 展会 ----
  async function loadExhibitions() {
    actions.clear(); forms.clear();
    const data = await api('/admin/exhibitions');
    const exhibitions = data.exhibitions || [];
    const exhibitionForm = (item) => registerForm({
      title: item ? item.name : t('admin:exhibitions.add'),
      message: t('admin:exhibitions.eventTimeHint'),
      submitTitle: item ? t('admin:exhibitions.save') : t('admin:exhibitions.publish'),
      fields: [
        { id: 'name', kind: 'text', label: t('admin:exhibitions.name'), value: item?.name || '', placeholder: t('admin:exhibitions.name') },
        { id: 'event_time', kind: 'datetime', label: t('admin:exhibitions.eventTime'), value: normalizeDateTime(item?.event_time) },
        { id: 'description', kind: 'textarea', label: t('admin:exhibitions.description'), value: item?.description || '', placeholder: t('admin:exhibitions.description') },
        { id: 'information', kind: 'textarea', label: t('admin:exhibitions.information'), value: item?.information || '', placeholder: t('admin:exhibitions.information') },
        { id: 'location_name', kind: 'text', label: t('admin:exhibitions.location'), value: item?.location_name || '', placeholder: t('admin:exhibitions.locationPlaceholder') },
        { id: 'latitude', kind: 'number', label: t('admin:exhibitions.latitude'), value: item?.latitude ?? '', placeholder: '23.016488' },
        { id: 'longitude', kind: 'number', label: t('admin:exhibitions.longitude'), value: item?.longitude ?? '', placeholder: '113.394404' },
        { id: 'icon', kind: 'image', label: t('admin:exhibitions.addIcon'), value: item?.icon_url || '', footer: t('admin:exhibitions.iconHint') }
      ],
      handler: async (values) => {
        const fields = {
          name: String(values.name || '').trim(),
          description: String(values.description || '').trim(),
          information: String(values.information || '').trim(),
          location_name: String(values.location_name || '').trim(),
          event_time: String(values.event_time || ''),
          latitude: values.latitude === '' ? null : Number(values.latitude),
          longitude: values.longitude === '' ? null : Number(values.longitude),
          icon_url: ''
        };
        if (!fields.name || !fields.description || !fields.information || !fields.event_time) return { error: t('admin:exhibitions.fillRequired') };
        let iconUrl = String(values.icon || '');
        if (iconUrl && !iconUrl.startsWith('http')) {
          const blob = base64Blob(iconUrl);
          if (!blob) return { error: t('admin:exhibitions.invalidImage') };
          const form = new FormData();
          form.append('image', blob, 'exhibition.jpg');
          const uploaded = await api('/upload', { method: 'POST', body: form });
          iconUrl = uploaded.url || '';
        }
        fields.icon_url = iconUrl;
        await api(item ? `/admin/exhibitions/${encodeURIComponent(item.id)}` : '/admin/exhibitions', {
          method: item ? 'PUT' : 'POST',
          body: JSON.stringify(fields)
        });
        return { page: await loadExhibitions(), message: item ? t('admin:exhibitions.published') : t('admin:exhibitions.published') };
      }
    });
    const rows = exhibitions.map((item) => ({
      id: String(item.id),
      title: item.name,
      subtitle: item.event_time || '',
      detail: [item.location_name, item.description].filter(Boolean).join(' · ').slice(0, 160),
      image: item.icon_url || '',
      actions: [
        formAction(t('admin:exhibitions.save'), () => exhibitionForm(item)),
        action(t('admin:exhibitions.unpublish'), async () => {
          await api(`/admin/exhibitions/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          return { page: await loadExhibitions(), message: t('admin:exhibitions.unpublished') };
        }, { tone: 'danger', confirm: { title: t('admin:exhibitions.unpublish'), message: t('admin:exhibitions.confirmUnpublish'), button: t('admin:exhibitions.unpublish') } })
      ]
    }));
    return basePage('admin-exhibitions', t('admin:exhibitions.title'), {
      subtitle: exhibitions.length ? t('admin:exhibitions.current', { name: exhibitions[0].name }) : t('admin:exhibitions.empty'),
      sections: [
        ...(rows.length ? [{ id: 'exhibitions', title: '', rows }] : []),
        { id: 'exhibition-new', title: t('admin:exhibitions.newActivity'), form: exhibitionForm(null) }
      ],
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadExhibitions() }))]
    });
  }

  // ---- 皮肤兑换码 ----
  async function loadSkinCodes() {
    actions.clear(); forms.clear();
    const state = stateFor('skinCodes');
    const data = await api('/admin/skin-codes');
    const catalog = data.catalog || [];
    const codes = data.codes || [];
    state.created = state.created || [];
    const skinName = (code) => code.skin_name || catalog.find((skin) => skin.id === code.skin_id)?.name || code.skin_id || '';
    const generateForm = registerForm({
      title: t('admin:skinCodes.intro'),
      submitTitle: t('admin:skinCodes.generate'),
      fields: [
        { id: 'skin_id', kind: 'select', label: t('admin:skinCodes.skin'), value: catalog[0]?.id || '', options: catalog.map((skin) => ({ id: skin.id, title: getSkin(skin.id) ? skin.name : t('admin:skinCodes.notInBuild', { name: skin.name }) })) },
        { id: 'count', kind: 'number', label: t('admin:skinCodes.count'), value: 10 },
        { id: 'max_uses', kind: 'number', label: t('admin:skinCodes.maxUses'), value: 1 },
        { id: 'expires_days', kind: 'number', label: t('admin:skinCodes.expiresDays'), value: '', footer: t('admin:skinCodes.expiresHint') },
        { id: 'note', kind: 'text', label: t('admin:skinCodes.note'), value: '', placeholder: t('admin:skinCodes.notePlaceholder') }
      ],
      handler: async (values) => {
        if (!values.skin_id) return { error: t('admin:skinCodes.emptyCatalog') };
        const result = await api('/admin/skin-codes', {
          method: 'POST',
          body: JSON.stringify({
            skin_id: values.skin_id,
            count: Number(values.count) || 1,
            max_uses: Number(values.max_uses) || 1,
            expires_days: values.expires_days === '' ? null : Number(values.expires_days),
            note: String(values.note || '').trim()
          })
        });
        state.created = result.codes || [];
        return { page: await loadSkinCodes(), message: t('admin:skinCodes.generated', { count: state.created.length }) };
      }
    });
    const rows = codes.map((code) => ({
      id: String(code.id),
      title: code.code,
      subtitle: `${skinName(code)} · ${t('admin:skinCodes.usage', { used: code.current_uses, max: code.max_uses })}`,
      detail: [code.expires_time ? new Date(code.expires_time).toLocaleString() : t('admin:skinCodes.never'), code.note || ''].filter(Boolean).join(' · '),
      badge: (SKIN_STATUS[code.status] || (() => code.status))(),
      badgeTone: code.status === 'active' ? 'success' : '',
      actions: code.status !== 'revoked' ? [action(t('admin:skinCodes.revoke'), async () => {
        await api(`/admin/skin-codes/${encodeURIComponent(code.id)}`, { method: 'DELETE' });
        return { page: await loadSkinCodes(), message: t('admin:skinCodes.revokedTip', { code: code.code }) };
      }, { tone: 'danger', confirm: { title: t('admin:skinCodes.revoke'), message: t('admin:skinCodes.confirmRevoke', { code: code.code }), button: t('admin:skinCodes.revoke') } })] : []
    }));
    const sections = [
      { id: 'skin-form', title: '', form: generateForm },
      ...(state.created.length ? [{ id: 'skin-created', title: t('admin:skinCodes.newCodes'), text: state.created.map((item) => item.code).join('\n') }] : []),
      ...(rows.length ? [{ id: 'skin-list', title: t('admin:skinCodes.listTitle'), rows }] : [])
    ];
    const buttons = [action(t('common:action.refresh'), async () => ({ page: await loadSkinCodes() }))];
    if (state.created.length) {
      buttons.push(action(t('admin:skinCodes.copyAll'), async () => {
        const ok = await copyText(state.created.map((item) => item.code).join('\n'));
        return { message: ok ? t('admin:skinCodes.copied') : t('admin:skinCodes.copyFailed') };
      }));
    }
    return basePage('admin-skin-codes', t('admin:skinCodes.title'), {
      subtitle: t('admin:skinCodes.intro'),
      sections,
      empty: catalog.length ? t('admin:skinCodes.empty') : t('admin:skinCodes.emptyCatalog'),
      buttons
    });
  }

  // ---- 反馈 ----
  async function loadFeedback() {
    actions.clear(); forms.clear();
    const state = stateFor('feedback');
    if (!state.tab) state.tab = 'open';
    const query = new URLSearchParams({ status: state.tab, page: String(state.page || 1), pageSize: '20' });
    const data = await api(`/admin/feedback?${query}`);
    const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 20)));
    state.total = data.total || 0;
    const rows = (data.items || []).map((item) => {
      const images = item.images || [];
      const resolve = action(item.status === 'resolved' ? t('admin:feedback.reopen') : t('admin:feedback.resolve'), async () => {
        await api(`/admin/feedback/${encodeURIComponent(item.id)}/status`, { method: 'PUT', body: JSON.stringify({ status: item.status === 'resolved' ? 'open' : 'resolved' }) });
        return { page: await loadFeedback(), message: item.status === 'resolved' ? t('admin:feedback.reopenedTip') : t('admin:feedback.resolvedTip') };
      });
      return {
        id: String(item.id),
        title: feedbackTypeLabel(item.type),
        subtitle: `${item.status === 'resolved' ? t('admin:feedback.status.resolved') : t('admin:feedback.status.open')} · #${item.id} · ${formatTime(item.created_time)}`,
        detail: [t('admin:feedback.from', { username: item.username || t('admin:feedback.unknownUser'), qq: item.qq || '-' }), item.content, images.length ? t('admin:feedback.imageCount', { count: images.length }) : ''].filter(Boolean).join('\n'),
        protectedImage: images[0] ? `feedback:${images[0].id}` : '',
        badge: item.status === 'resolved' ? t('admin:feedback.status.resolved') : '',
        badgeTone: item.status === 'resolved' ? 'success' : 'warning',
        actions: [resolve, action(t('admin:feedback.delete'), async () => {
          await api(`/admin/feedback/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          return { page: await loadFeedback(), message: t('admin:feedback.deletedTip') };
        }, { tone: 'danger', confirm: { title: t('admin:feedback.delete'), message: t('admin:feedback.confirmDelete'), button: t('admin:feedback.delete') } })]
      };
    });
    const prev = action(t('admin:feedback.prevPage'), async () => { state.page = Math.max(1, state.page - 1); return { page: await loadFeedback() }; });
    const next = action(t('admin:feedback.nextPage'), async () => { state.page = Math.min(totalPages, state.page + 1); return { page: await loadFeedback() }; });
    return basePage('admin-feedback', t('admin:feedback.title'), {
      subtitle: t('admin:feedback.intro'),
      tabs: [
        { id: 'open', title: t('admin:feedback.status.open') },
        { id: 'resolved', title: t('admin:feedback.status.resolved') },
        { id: 'all', title: t('admin:feedback.status.all') }
      ],
      selectedTab: state.tab,
      sections: rows.length ? [{ id: 'feedback', title: '', rows }] : [],
      empty: t('admin:feedback.empty'),
      pagerText: t('admin:feedback.pageInfo', { page: state.page, total: totalPages }),
      pagerPrev: state.page <= 1 ? '' : prev.id,
      pagerNext: state.page >= totalPages ? '' : next.id,
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadFeedback() }))]
    });
  }

  // ---- 审计 ----
  async function loadAudit() {
    actions.clear(); forms.clear();
    const logs = await api('/admin/audit');
    const rows = (logs || []).map((log) => ({
      id: String(log.id),
      title: log.action,
      subtitle: `${log.admin_id || '-'} · ${log.time || ''}`,
      detail: [log.target_user_id ? t('admin:auditModal.target', { id: log.target_user_id }) : '', log.ip || '', detailLines(log.details)].filter(Boolean).join('\n'),
      actions: []
    }));
    return basePage('admin-audit', t('admin:auditModal.title'), {
      sections: rows.length ? [{ id: 'audit', title: '', rows }] : [],
      empty: t('admin:auditModal.empty'),
      buttons: [action(t('common:action.refresh'), async () => ({ page: await loadAudit() }))]
    });
  }

  // ---- 事件入口 ----
  async function handle(type, payload = {}) {
    try {
      if (type === 'back') {
        return { page: dashboardPage() };
      }
      if (type === 'action') {
        const run = actions.get(payload.actionId);
        if (!run) return { error: t('admin:common.error.noPanelAccess') };
        return await run() || {};
      }
      if (type === 'filter') {
        if (!section) return { page: dashboardPage() };
        const state = stateFor(section);
        if (payload.filterId === 'search') {
          state.search = String(payload.value || '');
          state.page = 1;
        } else if (payload.filterId === 'tabs') {
          state.tab = String(payload.value || '');
          state.page = 1;
        }
        return { page: await load(section) };
      }
      if (type === 'submit') {
        const run = forms.get(payload.formId);
        if (!run) return { error: t('admin:common.error.noPanelAccess') };
        return await run(payload.values || {}) || {};
      }
      return {};
    } catch (error) {
      return { error: error?.message || t('admin:common.error.loadFailedWithMessage', { message: '' }) };
    }
  }

  async function loadImage(imageId) {
    try {
      if (String(imageId).startsWith('feedback:')) {
        const id = String(imageId).slice('feedback:'.length);
        const res = await fetch(`${backendUrl}/admin/feedback/images/${encodeURIComponent(id)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const data = await blobToBase64(blob);
        return { ok: true, imageId, imageData: data };
      }
      return { ok: false, imageId };
    } catch (error) {
      return { ok: false, imageId, message: error?.message || '' };
    }
  }

  return {
    dashboard: dashboardPage,
    load,
    handle,
    loadImage
  };
}

function firstPlaceImage(place, backendUrl) {
  try {
    const parse = (value) => {
      const list = Array.isArray(value) ? value : JSON.parse(value || '[]');
      return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : [];
    };
    const url = [...parse(place.exterior_images), ...parse(place.menu_images)][0];
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${backendUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  } catch (error) {
    return '';
  }
}

function normalizeDateTime(value) {
  if (!value) return '';
  return String(value).replace(' ', 'T').slice(0, 16);
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
