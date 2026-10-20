import assert from 'node:assert/strict';
import {
    ONBOARDING_VERSION, buildOnboardingSteps, parseOnboardingSeen, placeOnboardingCard, spotlightFor
} from '../../../src/map/onboarding.js';

// 已看过：只认当前版本，缺失或损坏的记录都要再显示
assert.equal(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_VERSION })), true);
assert.equal(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_VERSION - 1 })), false, 'old guide version shows again');
assert.equal(parseOnboardingSeen(null), false);
assert.equal(parseOnboardingSeen('{broken'), false);

// 步骤：各布局顺序相同；欢迎页和没有网页按钮的步骤（收在“更多”里、原生控件）居中显示
const ORDER = ['welcome', 'account', 'search', 'locate', 'favorites', 'add', 'alongRoute', 'more', 'journey'];
const centred = { desktop: ['welcome'], mobile: ['welcome', 'journey'], ios: ['welcome', 'alongRoute', 'journey'], native: ORDER };
for (const variant of ['desktop', 'mobile', 'ios', 'native']) {
    const steps = buildOnboardingSteps({ variant });
    assert.deepEqual(steps.map((step) => step.id), ORDER, `${variant} order`);
    for (const step of steps) {
        assert.ok(step.title && step.body && step.icon, `${variant}/${step.id} has copy and icon`);
        assert.equal(step.target, centred[variant].includes(step.id) ? null : step.id, `${variant}/${step.id} target`);
    }
}
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
