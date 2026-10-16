import assert from 'node:assert/strict';
import { createBackdropPressGuard } from "../../../src/components/overlay/backdropPress.js";

const backdrop = {};
const panel = {};
const pointer = (overrides = {}) => ({
    currentTarget: backdrop, target: backdrop,
    pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
    ...overrides
});
const click = (overrides = {}) => ({ currentTarget: backdrop, target: backdrop, detail: 1, ...overrides });

// 高德在 touchend 打开面板后，Android 补发的 click 没有在新遮罩上按下。
{
    const guard = createBackdropPressGuard();
    assert.equal(guard.consumeClick(click()), false, 'a map gesture must not dismiss the newly opened backdrop');
    guard.onPointerUp(pointer());
    assert.equal(guard.consumeClick(click()), false, 'release alone must not arm backdrop dismissal');
}

// 鼠标、触屏、触控笔正常点遮罩关闭；同一次按压只能消费一次。
for (const pointerType of ['mouse', 'touch', 'pen']) {
    const guard = createBackdropPressGuard();
    guard.onPointerDown(pointer({ pointerType }));
    guard.onPointerUp(pointer({ pointerType }));
    guard.onPointerLeave(); // 触屏抬起后会离开命中区域，仍应接受紧随其后的 click。
    assert.equal(guard.consumeClick(click()), true, `${pointerType} backdrop press should dismiss`);
    assert.equal(guard.consumeClick(click()), false, 'a second click needs a new press');
}

// 取消、移出遮罩、跨面板释放、第二根手指、右键都不能授权关闭。
for (const interrupt of [
    (guard) => guard.onPointerCancel(),
    (guard) => guard.onPointerLeave(),
    (guard) => guard.onPointerUp(pointer({ target: panel })),
    (guard) => guard.onPointerUp(pointer({ pointerId: 2 })),
    (guard) => guard.onPointerDown(pointer({ pointerId: 2, isPrimary: false })),
    (guard) => guard.onPointerDown(pointer({ button: 2 }))
]) {
    const guard = createBackdropPressGuard();
    guard.onPointerDown(pointer());
    interrupt(guard);
    assert.equal(guard.consumeClick(click()), false, 'an incomplete or interrupted press must not dismiss');
}

{
    const guard = createBackdropPressGuard();
    guard.onPointerDown(pointer({ target: panel }));
    guard.onPointerUp(pointer());
    assert.equal(guard.consumeClick(click()), false, 'a press starting inside the panel must not dismiss');
    guard.onPointerDown(pointer());
    guard.onPointerUp(pointer());
    assert.equal(guard.consumeClick(click({ target: panel })), false, 'a panel click must not dismiss');
}

// 不要求键盘、辅助技术或程序触发的语义点击带有指针按压。
assert.equal(createBackdropPressGuard().consumeClick(click({ detail: 0 })), true);

// 触屏隐式捕获后，pointerup.target 仍可能是遮罩，要按实际松手位置判断。
for (const [hit, allowed] of [[panel, false], [null, false], [backdrop, true]]) {
    const capturedBackdrop = {
        ownerDocument: { elementFromPoint: () => hit === backdrop ? capturedBackdrop : hit }
    };
    const event = pointer({ currentTarget: capturedBackdrop, target: capturedBackdrop, clientX: 20, clientY: 30 });
    const guard = createBackdropPressGuard();
    guard.onPointerDown(event);
    guard.onPointerUp(event);
    guard.onPointerLeave();
    assert.equal(guard.consumeClick(click({ currentTarget: capturedBackdrop, target: capturedBackdrop })), allowed,
        'a captured pointer must release over the backdrop, not inside the panel or outside the viewport');
}

console.log('overlay interaction tests passed');
