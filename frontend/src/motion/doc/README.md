# 动效政策与页面转场

policy.js 是 React 与地图控制器共享的非 React 状态；presets 定义动效；MotionProvider 汇总布局与偏好；PageTransition 维护页面覆盖与方向。持久键 yuyuko.motion.v1 保留，系统减少动态效果/透明度、页面可见性、性能降级都会影响策略。

```mermaid
flowchart LR
    Inputs[用户开关 / 系统偏好 / 页面可见 / 性能] --> Policy[derive 统一快照]
    Policy --> Subscribers[订阅者收到策略变化]
    Subscribers --> UI[React 弹层与页面]
    Subscribers --> Map[地图聚合动画]
    UI --> Preset[选择预设或减少过渡]
    Map --> Snap[动画或直接稳定快照]
    Preset --> State[完成后仍发布正确最终状态]
    Snap --> State
```

当前把动画表现和数据正确性分开，对照关闭动画时跳过状态同步，前者保留正确性。页面不可见时避免多余动效，但不把可见性变更当数据重置。已有 test:map 涵盖部分政策与转场逻辑；完整视觉节奏和降级下 UI 一致性仍需浏览器/真机。文字案例：MOT-C01 关闭动效后标记成员不丢；MOT-C02 切后台再回前台当前页/overlay 不残留；MOT-C03 降级期间打断转场后最终页面与可点区域一致。后两项需专项覆盖，见 UI-01 的 [清单](../../../doc/HISTORY_AND_TODO.md)。
