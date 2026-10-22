import assert from 'node:assert/strict';
import {
    ONBOARDING_VERSION, buildOnboardingSteps, nativeTourRect, parseOnboardingSeen, placeOnboardingCard, spotlightFor, unionBox
} from '../../../src/map/onboarding.js';

// 已看过：只认当前版本，缺失或损坏的记录都要再显示
assert.equal(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_VERSION })), true);
assert.equal(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_VERSION - 1 })), false, 'old guide version shows again');
assert.equal(parseOnboardingSeen(null), false);
assert.equal(parseOnboardingSeen('{broken'), false);

// 步骤：先是看得见的按钮，然后是“更多”，最后是收在“更多”里的功能；欢迎页居中，收在“更多”里的步骤指向“更多”按钮
const ORDER = {
    desktop: ['welcome', 'account', 'search', 'locate', 'favorites', 'add', 'alongRoute', 'journey', 'more'],
    mobile: ['welcome', 'account', 'search', 'locate', 'favorites', 'add', 'alongRoute', 'more', 'journey'],
    ios: ['welcome', 'account', 'search', 'locate', 'favorites', 'add', 'more', 'alongRoute', 'journey'],
    native: ['welcome', 'account', 'search', 'locate', 'favorites', 'add', 'journey', 'more', 'alongRoute']
};
const inMore = { desktop: [], mobile: ['journey'], ios: ['alongRoute', 'journey'], native: ['alongRoute'] };
for (const variant of ['desktop', 'mobile', 'ios', 'native']) {
    const steps = buildOnboardingSteps({ variant });
    assert.deepEqual(steps.map((step) => step.id), ORDER[variant], `${variant} order`);
    for (const step of steps) {
        assert.ok(step.title && step.body && step.icon, `${variant}/${step.id} has copy and icon`);
        const target = variant === 'native' || step.id === 'welcome' ? null : (inMore[variant].includes(step.id) ? 'more' : step.id);
        assert.equal(step.target, target, `${variant}/${step.id} target`);
        // 写给用户的位置：原生布局每一步都有（欢迎页除外），网页布局只有收在“更多”里的步骤有
        const where = variant === 'native' ? step.id !== 'welcome' : inMore[variant].includes(step.id);
        assert.equal(!!step.where?.text, where, `${variant}/${step.id} where`);
        assert.equal('native' in step, variant === 'native', `${variant}/${step.id} native tour`);
    }
}

// 原生工具栏：网页指不到原生按钮，由原生高亮；“更多功能”一步示意并练习上滑，顺路吃在展开的更多功能里
const nativeSteps = Object.fromEntries(buildOnboardingSteps({ variant: 'native' }).map((step) => [step.id, step]));
assert.deepEqual(nativeSteps.welcome.native, { target: null, drawer: false });
for (const id of ['account', 'search', 'locate', 'favorites', 'add', 'journey']) {
    assert.deepEqual(nativeSteps[id].native, { target: id, drawer: false }, `native ${id}`);
}
assert.deepEqual(nativeSteps.more.native, { target: 'drawer', drawer: false });
assert.equal(nativeSteps.more.practice, 'drawer');
assert.ok(nativeSteps.more.hint, 'More asks the user to try swiping up');
assert.equal(nativeSteps.more.where.icon, 'swipe_up');
assert.deepEqual(nativeSteps.alongRoute.native, { target: 'alongRoute', drawer: true });
assert.equal(buildOnboardingSteps({ variant: 'ios' }).some((step) => step.practice), false, 'only the native toolbar can practise');

// 原生回传的位置只属于它报上来的那一步
const rect = { left: 12, top: 700, right: 378, bottom: 772 };
assert.equal(nativeTourRect(nativeSteps.search, { step: 'search', rect }), rect);
assert.equal(nativeTourRect(nativeSteps.search, { step: 'account', rect }), null, 'stale position from the previous step');
assert.equal(nativeTourRect(nativeSteps.search, null), null);
assert.equal(nativeTourRect(buildOnboardingSteps({ variant: 'ios' })[2], { step: 'search', rect }), null, 'web steps use data-tour');
assert.deepEqual(unionBox({ left: 300, top: 600, width: 50, height: 50 }, { left: 12, top: 640, width: 366, height: 80 }), { left: 12, top: 600, width: 366, height: 120 });
assert.deepEqual(unionBox(null, rect), rect);

const more = (variant) => buildOnboardingSteps({ variant }).find((step) => step.id === 'more').body;
assert.equal(new Set(['desktop', 'mobile', 'ios', 'native'].map(more)).size, 4, 'More copy matches each layout');
const account = (isAuthenticated) => buildOnboardingSteps({ variant: 'mobile', isAuthenticated }).find((step) => step.id === 'account');
assert.equal(account(false).icon, 'login');
assert.equal(account(true).icon, 'person');
assert.notEqual(account(false).title, account(true).title);

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
