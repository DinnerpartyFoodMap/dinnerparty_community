import assert from 'node:assert/strict';
import { localeText } from '../../support/locale-text.mjs';
import {
    ONBOARDING_VERSION, buildOnboardingSteps, nativeTourRect, parseOnboardingSeen, placeOnboardingCard, spotlightFor, unionBox
} from '../../../src/map/onboarding.js';
import { FEATURE_INTRO_KEY, takeFeatureIntro } from '../../../src/map/featureIntro.js';

// 已看过：只认当前版本，缺失或损坏的记录都要再显示
assert.equal(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_VERSION })), true);
assert.equal(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_VERSION - 1 })), false, 'old guide version shows again');
assert.equal(parseOnboardingSeen(null), false);
assert.equal(parseOnboardingSeen('{broken'), false);

// iOS 要先学会打开更多功能；其他布局保留三步。“打开店卡”没有目标，居中显示。
for (const variant of ['desktop', 'mobile', 'ios', 'native']) {
    const steps = buildOnboardingSteps({ variant });
    const expectedOrder = variant === 'ios' || variant === 'native'
        ? ['search', 'card', 'more', 'favorites']
        : ['search', 'card', 'favorites'];
    assert.deepEqual(steps.map((step) => step.id), expectedOrder, `${variant} order`);
    for (const step of steps) {
        assert.ok(step.title && step.body && step.icon, `${variant}/${step.id} has copy and icon`);
        const target = variant === 'native' || step.id === 'card' ? null : step.id;
        assert.equal(step.target, target, `${variant}/${step.id} target`);
        // 写给用户的位置：只有原生布局需要（网页的高亮框已经指明了位置），“打开店卡”没有按钮
        assert.equal(!!step.where?.text, variant === 'native' && step.id !== 'card', `${variant}/${step.id} where`);
        assert.equal('native' in step, variant === 'native', `${variant}/${step.id} native tour`);
        assert.equal(step.practice, variant === 'native' && step.id === 'more' ? 'drawer' : undefined, `${variant}/${step.id} practice`);
    }
}

// 原生工具栏：网页指不到原生按钮，由原生高亮
const nativeSteps = Object.fromEntries(buildOnboardingSteps({ variant: 'native' }).map((step) => [step.id, step]));
assert.deepEqual(nativeSteps.search.native, { target: 'search', drawer: false });
assert.deepEqual(nativeSteps.card.native, { target: null, drawer: false });
assert.deepEqual(nativeSteps.more.native, { target: 'drawer', drawer: false }, 'more starts with the drawer closed so users can practise opening it');
assert.deepEqual(nativeSteps.favorites.native, { target: 'favorites', drawer: false });
assert.equal(nativeSteps.more.where.icon, 'swipe_up');
assert.equal(nativeSteps.more.body, localeText('map:onboarding.more.bodyNative'), 'native copy explains the available drawer gesture');
assert.equal(nativeSteps.more.hint, localeText('map:onboarding.more.practice'), 'native swipe practice explains automatic advancement');

// iOS 原生工具栏不可用时，网页只有“更多”按钮，不要求上滑练习。
const iosMore = buildOnboardingSteps({ variant: 'ios' }).find((step) => step.id === 'more');
assert.equal(iosMore.target, 'more', 'web fallback highlights its actual more button');
assert.equal(iosMore.body, localeText('map:onboarding.more.bodyIos'), 'web fallback explains the more button');
assert.equal(iosMore.practice, undefined, 'web fallback does not request native swipe practice');
assert.equal(iosMore.hint, undefined, 'web fallback has no native swipe instruction');

// 其他功能第一次用到时提示一句，每个功能只提示一次
function memoryStorage() {
    const data = new Map();
    return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
}
const introStorage = memoryStorage();
assert.ok(takeFeatureIntro('filter', introStorage), 'first filter use shows an intro');
assert.equal(takeFeatureIntro('filter', introStorage), null, 'only once');
assert.deepEqual(JSON.parse(introStorage.getItem(FEATURE_INTRO_KEY)), ['filter']);
assert.equal(takeFeatureIntro('unknown', introStorage), null);
const seenElsewhere = memoryStorage();
seenElsewhere.setItem(FEATURE_INTRO_KEY, JSON.stringify(['listView']));
assert.equal(takeFeatureIntro('listView', seenElsewhere), null, 'remembered across sessions');
assert.ok(takeFeatureIntro('alongRoute', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }), 'storage errors still show the intro');

// 浏览器可能在读取 localStorage 属性时就抛异常，仍应显示介绍并在当前会话中去重。
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Storage access denied', 'SecurityError'); }
});
try {
    const { takeFeatureIntro: takeBlockedIntro } = await import('../../../src/map/featureIntro.js?blocked-storage');
    for (const id of ['filter', 'listView', 'alongRoute']) {
        let intro;
        assert.doesNotThrow(() => { intro = takeBlockedIntro(id); }, `${id} tolerates a blocked storage getter`);
        assert.ok(intro, `${id} still shows its first-use intro`);
        assert.equal(takeBlockedIntro(id), null, `${id} is not repeated in this session`);
    }
} finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
}

// 原生回传的位置只属于它报上来的那一步
const rect = { left: 12, top: 700, right: 378, bottom: 772 };
assert.equal(nativeTourRect(nativeSteps.search, { step: 'search', rect }), rect);
assert.equal(nativeTourRect(nativeSteps.search, { step: 'favorites', rect }), null, 'stale position from another step');
assert.equal(nativeTourRect(nativeSteps.search, null), null);
assert.equal(nativeTourRect(buildOnboardingSteps({ variant: 'ios' })[0], { step: 'search', rect }), null, 'web steps use data-tour');
assert.deepEqual(unionBox({ left: 300, top: 600, width: 50, height: 50 }, { left: 12, top: 640, width: 366, height: 80 }), { left: 12, top: 600, width: 366, height: 120 });
assert.deepEqual(unionBox(null, rect), rect);

// 高亮框：换算到指引层坐标，方形按钮画成圆，贴边时不超出层
const bounds = { left: 0, top: 20, width: 390, height: 800 };
assert.deepEqual(spotlightFor({ left: 100, top: 120, right: 144, bottom: 164 }, bounds), { left: 94, top: 94, width: 56, height: 56, radius: 28 });
const toolbarButton = spotlightFor({ left: 150, top: 760, right: 226, bottom: 818 }, bounds);
assert.equal(toolbarButton.radius, 16, 'wide toolbar button is a rounded rectangle');
assert.equal(toolbarButton.top + toolbarButton.height, 798, 'clamped inside the layer');

const card = { width: 340, height: 180 };
const phone = { width: 390, height: 800 };
const center = placeOnboardingCard({ hole: null, bounds: phone, card });
assert.equal(center.side, 'center');
assert.equal(center.left, 25);
assert.equal(center.top, 310);

// 底部工具栏按钮：卡片在上方，并保持在屏幕内
const bottom = placeOnboardingCard({ hole: { left: 4, top: 730, width: 70, height: 64 }, bounds: phone, card });
assert.equal(bottom.side, 'above');
assert.equal(bottom.top, 730 - 12 - 180);
assert.equal(bottom.left, 12, 'clamped to the margin');

// 右上角头像：卡片在下方
const avatar = placeOnboardingCard({ hole: { left: 330, top: 10, width: 52, height: 52 }, bounds: phone, card });
assert.equal(avatar.side, 'below');
assert.equal(avatar.left, 390 - 12 - 340);

// 宽屏右侧圆钮列：放在按钮左边，不挡住同一列的其他按钮
const desktop = { width: 1280, height: 800 };
const column = placeOnboardingCard({ hole: { left: 1222, top: 118, width: 56, height: 56 }, bounds: desktop, card });
assert.equal(column.side, 'left');
assert.equal(column.left, 1222 - 12 - 340);
assert.equal(column.top, 118 + 28 - 90, 'vertically centred on the button');
const columnTop = placeOnboardingCard({ hole: { left: 1222, top: 66, width: 56, height: 56 }, bounds: desktop, card });
assert.equal(columnTop.top, 12, 'clamped to the top margin');

// 宽屏居中的搜索框：放在下方
const search = placeOnboardingCard({ hole: { left: 430, top: 4, width: 420, height: 56 }, bounds: desktop, card });
assert.equal(search.side, 'below');
assert.equal(search.left, Math.round(640 - 170));

// 哪里都放不下：放在空间较大的一侧并限制在屏幕内
const tiny = placeOnboardingCard({ hole: { left: 20, top: 40, width: 350, height: 300 }, bounds: { width: 390, height: 500 }, card });
assert.equal(tiny.side, 'below');
assert.ok(tiny.top >= 12 && tiny.top + card.height <= 500 - 12);

console.log('Onboarding steps and placement passed.');
