// 图标对照表（frontend/doc/DESIGN_SYSTEM.md 第 6 节）：业务里写语义名，网页用 Material Symbols、iOS 原生用 SF Symbols，
// 两端同一含义。新增图标在这里加一行；npm run test:design-lint 会拦下在别处直接写的 SF Symbol 名。
// 选中 / 已收藏等实心状态：网页用同一个 Material 名加 FILL 1，原生用 .fill 变体（两个语义名）。
const ICONS = Object.freeze({
    // 地图工具栏与浮动按钮
    search: ['search', 'magnifyingglass'],
    add: ['add_location_alt', 'plus.circle.fill'],
    addCancel: ['close', 'xmark.circle.fill'],
    filter: ['filter_list', 'line.3.horizontal.decrease.circle'],
    filterActive: ['filter_list', 'line.3.horizontal.decrease.circle.fill'],
    clearFilter: ['filter_alt_off', 'xmark.circle'],
    include: ['check', 'checkmark'],
    exclude: ['block', 'nosign'],
    random: ['casino', 'dice'],
    redraw: ['filter_center_focus', 'scope'],
    centerMap: ['map', 'map'],
    centerLocation: ['my_location', 'location'],
    alongRoute: ['route', 'point.topleft.down.to.point.bottomright.curvepath'],
    journey: ['menu_book', 'book.closed'],
    admin: ['admin_panel_settings', 'gearshape.2'],
    guide: ['help', 'questionmark.circle'],
    feedback: ['feedback', 'exclamationmark.bubble'],
    retry: ['refresh', 'arrow.clockwise'],
    // 地点与店卡
    place: ['location_on', 'mappin.and.ellipse'],
    placeRow: ['location_on', 'mappin.circle.fill'],
    share: ['ios_share', 'square.and.arrow.up'],
    navigate: ['directions', 'arrow.triangle.turn.up.right.diamond.fill'],
    favorite: ['favorite', 'heart'],
    favoriteFill: ['favorite', 'heart.fill'],
    create: ['add_circle', 'plus.circle'],
    edit: ['edit', 'pencil'],
    report: ['flag', 'flag'],
    hidden: ['visibility_off', 'eye.slash'],
    diaries: ['auto_stories', 'book.pages'],
    comments: ['chat_bubble', 'text.bubble'],
    details: ['info', 'info.circle'],
    // 评价四档（设计参考 1.4）
    thumbUp: ['thumb_up', 'hand.thumbsup'],
    thumbUpFill: ['thumb_up', 'hand.thumbsup.fill'],
    thumbDown: ['thumb_down', 'hand.thumbsdown'],
    thumbDownFill: ['thumb_down', 'hand.thumbsdown.fill'],
    // 账号与住民
    account: ['account_circle', 'person.crop.circle'],
    profile: ['badge', 'person.text.rectangle'],
    unblock: ['how_to_reg', 'person.crop.circle.badge.checkmark'],
    logout: ['logout', 'rectangle.portrait.and.arrow.right'],
    adminBadge: ['verified_user', 'checkmark.shield.fill'],
    // 管理后台各分区
    adminUsers: ['group', 'person.2.fill'],
    adminTasteAxes: ['restaurant', 'fork.knife'],
    adminWhitelist: ['checklist', 'checklist'],
    adminNotices: ['campaign', 'megaphone.fill'],
    adminExhibitions: ['confirmation_number', 'ticket.fill'],
    adminFeedback: ['forum', 'bubble.left.and.bubble.right.fill'],
    adminAudit: ['manage_search', 'doc.text.magnifyingglass'],
    // 协议与备案
    terms: ['description', 'doc.plaintext'],
    privacy: ['privacy_tip', 'hand.raised'],
    icp: ['article', 'doc.text'],
    gongan: ['verified_user', 'checkmark.shield'],
    // 反馈类型
    feedbackBug: ['bug_report', 'ladybug'],
    feedbackSuggestion: ['lightbulb', 'lightbulb'],
    feedbackReport: ['report', 'exclamationmark.shield'],
    feedbackAccount: ['manage_accounts', 'person.crop.circle.badge.questionmark'],
    feedbackOther: ['chat_bubble', 'ellipsis.bubble']
});

function entry(name) {
    const pair = ICONS[name];
    if (!pair) throw new Error(`Unknown icon "${name}" (add it to iconRegistry.js)`);
    return pair;
}

/** 网页 Material Symbols 名 */
export function materialIcon(name) {
    return entry(name)[0];
}

/** iOS 原生 SF Symbols 名 */
export function sfSymbol(name) {
    return entry(name)[1];
}

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));
