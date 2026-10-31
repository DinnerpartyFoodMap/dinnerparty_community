import SwiftUI
import UIKit
import PhotosUI
import Capacitor

/// 原生页面引擎：网页下发声明式页面模型，SwiftUI 负责系统分组列表、页面栈、输入与动作。
/// 管理后台与日记 · 同好共用；所有账号请求、权限与业务规则仍在网页层。
/// 页面结构与住民设置一致：根页与子页都是 insetGrouped 列表，子页由 NavigationStack 推入（系统返回与侧滑）；
/// 一行有多个操作时推入这一行的详情页，表单也是推入的页面，不再用操作菜单或全屏弹窗。
enum NativePageValue: Equatable {
    case text(String)
    case number(Double)
    case bool(Bool)
    case list([String])
    case none

    var text: String {
        switch self {
        case .text(let value): return value
        case .number(let value): return value == value.rounded() ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "1" : ""
        case .list(let value): return value.joined(separator: "\n")
        case .none: return ""
        }
    }

    var bool: Bool {
        switch self {
        case .bool(let value): return value
        case .number(let value): return value != 0
        case .text(let value): return value == "1" || value.lowercased() == "true"
        case .list(let value): return !value.isEmpty
        case .none: return false
        }
    }

    var list: [String] {
        if case .list(let value) = self { return value }
        return []
    }

    var bridgeValue: Any {
        switch self {
        case .text(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .list(let value): return value
        case .none: return NSNull()
        }
    }

    static func parse(_ raw: Any?) -> NativePageValue {
        guard let value = raw else { return .none }
        if value is NSNull { return .none }
        switch value {
        case let text as String: return .text(text)
        case let number as NSNumber:
            if String(cString: number.objCType) == "c" { return .bool(number.boolValue) }
            return .number(number.doubleValue)
        case let values as [Any]: return .list(values.compactMap { $0 as? String })
        default: return .none
        }
    }
}

struct NativePageAction: Identifiable {
    let id: String
    let title: String
    let tone: String
    let kind: String
    let confirmTitle: String
    let confirmMessage: String
    let confirmButton: String
    /// 打开下一级页面：点按后立即推入占位页，网页回传后换成真正的页面
    let push: Bool

    var destructive: Bool { tone == "danger" || tone == "warning" }
}

struct NativePageOption: Identifiable {
    let id: String
    let title: String
}

struct NativePageChip: Identifiable {
    let id: String
    let text: String
    let tone: String
}

struct NativePageField: Identifiable {
    let id: String
    let kind: String
    let label: String
    let placeholder: String
    let footer: String
    let options: [NativePageOption]
    let value: NativePageValue
}

struct NativePageForm: Identifiable {
    let id: String
    let title: String
    let message: String
    let submitId: String
    let submitTitle: String
    let openTitle: String
    let cancelTitle: String
    let fields: [NativePageField]
}

struct NativePageRow: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let detail: String
    let image: String
    let protectedImage: String
    let badge: String
    let badgeTone: String
    let chips: [NativePageChip]
    let actions: [NativePageAction]
    let selected: Bool
}

struct NativeCalendarDay: Identifiable {
    let id: String
    let day: Int
    let count: Int
    let hasDraft: Bool
    let selected: Bool
    let action: String
}

struct NativePageCalendar {
    let monthLabel: String
    let weekdays: [String]
    let days: [NativeCalendarDay]
    let previousAction: String
    let nextAction: String
}

struct NativePageImageItem: Identifiable {
    let id: String
    let caption: String
    let image: String
    let protectedImage: String
    let actions: [NativePageAction]
}

struct NativePageSection: Identifiable {
    let id: String
    let title: String
    let text: String
    let rows: [NativePageRow]
    let form: NativePageForm?
    let calendar: NativePageCalendar?
    let images: [NativePageImageItem]
}

struct NativePageSpec {
    let id: String
    let title: String
    let subtitle: String
    let message: String
    let error: String
    let emptyText: String
    let canGoBack: Bool
    let searchPlaceholder: String
    let searchValue: String
    let tabs: [NativePageOption]
    let selectedTab: String
    let sections: [NativePageSection]
    let buttons: [NativePageAction]
    let pagerText: String
    let pagerPrev: String
    let pagerNext: String
    let loading: Bool
    let backTitle: String
    let closeTitle: String
    /// 在网页侧的层级：0 为根页（入口 / 后台首页），越深越大；决定新页面是推入、刷新还是退回
    let level: Int
    let cancelTitle: String
    let okTitle: String
    let timeoutText: String
    let pickImageTitle: String
    let removeImageTitle: String

    static let empty = NativePageSpec(
        id: "empty", title: "", subtitle: "", message: "", error: "", emptyText: "",
        canGoBack: false, searchPlaceholder: "", searchValue: "", tabs: [], selectedTab: "",
        sections: [], buttons: [], pagerText: "", pagerPrev: "", pagerNext: "",
        loading: true, backTitle: "返回", closeTitle: "关闭", level: 0,
        cancelTitle: "取消", okTitle: "好", timeoutText: "请求超时，请稍后重试",
        pickImageTitle: "选择图片", removeImageTitle: "移除"
    )
}

enum NativePageParser {
    static func strings(_ object: JSObject?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in object ?? [:] {
            if let text = value as? String { out[key] = text }
        }
        return out
    }

    static func options(_ value: Any?) -> [NativePageOption] {
        (value as? JSArray ?? []).compactMap { entry -> NativePageOption? in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            return NativePageOption(id: id, title: item["title"] as? String ?? id)
        }
    }

    static func actions(_ value: Any?) -> [NativePageAction] {
        (value as? JSArray ?? []).compactMap { entry -> NativePageAction? in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            let confirm = item["confirm"] as? JSObject
            return NativePageAction(
                id: id,
                title: item["title"] as? String ?? id,
                tone: item["tone"] as? String ?? "",
                kind: item["kind"] as? String ?? "action",
                confirmTitle: confirm?["title"] as? String ?? "",
                confirmMessage: confirm?["message"] as? String ?? "",
                confirmButton: confirm?["button"] as? String ?? (item["title"] as? String ?? ""),
                push: item["push"] as? Bool ?? false
            )
        }
    }

    static func chips(_ value: Any?) -> [NativePageChip] {
        (value as? JSArray ?? []).enumerated().compactMap { (index, entry) -> NativePageChip? in
            guard let item = entry as? JSObject else { return nil }
            let text = item["text"] as? String ?? ""
            guard !text.isEmpty else { return nil }
            return NativePageChip(id: "\(index)-\(text)", text: text, tone: item["tone"] as? String ?? "")
        }
    }

    static func fields(_ value: Any?) -> [NativePageField] {
        (value as? JSArray ?? []).compactMap { entry -> NativePageField? in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            return NativePageField(
                id: id,
                kind: item["kind"] as? String ?? "text",
                label: item["label"] as? String ?? "",
                placeholder: item["placeholder"] as? String ?? "",
                footer: item["footer"] as? String ?? "",
                options: options(item["options"]),
                value: NativePageValue.parse(item["value"])
            )
        }
    }

    static func form(_ value: Any?) -> NativePageForm? {
        guard let item = value as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
        return NativePageForm(
            id: id,
            title: item["title"] as? String ?? "",
            message: item["message"] as? String ?? "",
            submitId: item["submitId"] as? String ?? "submit",
            submitTitle: item["submitTitle"] as? String ?? "保存",
            openTitle: item["openTitle"] as? String ?? (item["submitTitle"] as? String ?? "编辑"),
            cancelTitle: item["cancelTitle"] as? String ?? "取消",
            fields: fields(item["fields"])
        )
    }

    static func rows(_ value: Any?) -> [NativePageRow] {
        (value as? JSArray ?? []).compactMap { entry -> NativePageRow? in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            return NativePageRow(
                id: id,
                title: item["title"] as? String ?? "",
                subtitle: item["subtitle"] as? String ?? "",
                detail: item["detail"] as? String ?? "",
                image: item["image"] as? String ?? "",
                protectedImage: item["protectedImage"] as? String ?? "",
                badge: item["badge"] as? String ?? "",
                badgeTone: item["badgeTone"] as? String ?? "",
                chips: chips(item["chips"]),
                actions: actions(item["actions"]),
                selected: item["selected"] as? Bool ?? false
            )
        }
    }

    static func images(_ value: Any?) -> [NativePageImageItem] {
        (value as? JSArray ?? []).compactMap { entry -> NativePageImageItem? in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            return NativePageImageItem(
                id: id,
                caption: item["caption"] as? String ?? "",
                image: item["image"] as? String ?? "",
                protectedImage: item["protectedImage"] as? String ?? "",
                actions: actions(item["actions"])
            )
        }
    }

    static func calendar(_ value: Any?) -> NativePageCalendar? {
        guard let item = value as? JSObject else { return nil }
        let days = (item["days"] as? JSArray ?? []).enumerated().compactMap { (index, entry) -> NativeCalendarDay? in
            guard let day = entry as? JSObject else { return nil }
            return NativeCalendarDay(
                id: day["id"] as? String ?? "day-\(index)",
                day: (day["day"] as? NSNumber)?.intValue ?? 0,
                count: (day["count"] as? NSNumber)?.intValue ?? 0,
                hasDraft: day["draft"] as? Bool ?? false,
                selected: day["selected"] as? Bool ?? false,
                action: day["action"] as? String ?? ""
            )
        }
        return NativePageCalendar(
            monthLabel: item["monthLabel"] as? String ?? "",
            weekdays: (item["weekdays"] as? JSArray ?? []).compactMap { $0 as? String },
            days: days,
            previousAction: item["prev"] as? String ?? "",
            nextAction: item["next"] as? String ?? ""
        )
    }

    static func section(_ value: Any?) -> NativePageSection? {
        guard let item = value as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
        return NativePageSection(
            id: id,
            title: item["title"] as? String ?? "",
            text: item["text"] as? String ?? "",
            rows: rows(item["rows"]),
            form: form(item["form"]),
            calendar: calendar(item["calendar"]),
            images: images(item["images"])
        )
    }

    static func spec(_ value: Any?) -> NativePageSpec {
        guard let item = value as? JSObject else { return .empty }
        let canGoBack = item["canGoBack"] as? Bool ?? false
        let labels = strings(item["labels"] as? JSObject)
        func label(_ key: String, _ fallback: String) -> String {
            guard let text = labels[key], !text.isEmpty else { return fallback }
            return text
        }
        return NativePageSpec(
            id: item["id"] as? String ?? "page-\(UUID().uuidString)",
            title: item["title"] as? String ?? "",
            subtitle: item["subtitle"] as? String ?? "",
            message: item["message"] as? String ?? "",
            error: item["error"] as? String ?? "",
            emptyText: item["empty"] as? String ?? "",
            canGoBack: canGoBack,
            searchPlaceholder: item["searchPlaceholder"] as? String ?? "",
            searchValue: item["searchValue"] as? String ?? "",
            tabs: options(item["tabs"]),
            selectedTab: item["selectedTab"] as? String ?? "",
            sections: (item["sections"] as? JSArray ?? []).compactMap { section($0) },
            buttons: actions(item["buttons"]),
            pagerText: item["pagerText"] as? String ?? "",
            pagerPrev: item["pagerPrev"] as? String ?? "",
            pagerNext: item["pagerNext"] as? String ?? "",
            loading: item["loading"] as? Bool ?? false,
            backTitle: item["backTitle"] as? String ?? "返回",
            closeTitle: item["closeTitle"] as? String ?? "关闭",
            level: (item["level"] as? NSNumber)?.intValue ?? (canGoBack ? 1 : 0),
            cancelTitle: label("cancel", "取消"),
            okTitle: label("ok", "好"),
            timeoutText: label("timeout", "请求超时，请稍后重试"),
            pickImageTitle: label("pickImage", "选择图片"),
            removeImageTitle: label("removeImage", "移除")
        )
    }
}

// MARK: - 状态

struct NativePageConfirm: Identifiable {
    let id = UUID()
    let action: NativePageAction
}

/// 页面栈里的一页。page 是网页下发的页面（level 为它在网页侧的层级，0 为根页）；
/// loading 是点开下一级后、网页还没回传时先推入的占位页；row / form 是原生自己的二级页
/// （一行有多个操作时的详情页、可编辑的表单），属于下面那一级网页页面（level 相同、local 为真）。
enum NativePageScreen {
    case page(NativePageSpec)
    case loading(title: String, level: Int)
    case row(NativePageRow, level: Int)
    case form(NativePageForm, level: Int)

    var level: Int {
        switch self {
        case .page(let spec): return spec.level
        case .loading(_, let level), .row(_, let level), .form(_, let level): return level
        }
    }

    /// 原生自己的二级页（不对应网页页面）
    var local: Bool {
        switch self {
        case .row, .form: return true
        default: return false
        }
    }
}

struct NativePageRoute: Hashable {
    let id: Int
}

/// 管理后台与日记 · 同好共用的页面栈：根页 + NavigationStack 路径。
/// 网页按“动作 → 新页面”回传；新页面的 level 决定推入（更深）、原地刷新（同级）还是退回（更浅）。
/// 系统返回（导航栏返回、左边缘侧滑）由 NavigationStack 完成，弹出网页页面后通知网页回到对应层级。
final class NativePageModel: ObservableObject {
    @Published var root: NativePageSpec
    @Published var path: [NativePageRoute] = [] {
        didSet { pathChanged(from: oldValue) }
    }
    @Published private(set) var screens: [Int: NativePageScreen] = [:]
    @Published private(set) var loading = false
    /// 正在等网页回传的那一行（行尾显示转圈）
    @Published private(set) var busyRow: String?
    @Published var toast: String?
    @Published var alertMessage: String?
    @Published var images: [String: UIImage] = [:]
    @Published var confirming: NativePageConfirm?

    /// 子页数量变化：插件据此只在根页启用“侧滑关闭整页”，子页交给 NavigationStack 的系统返回
    var onDepthChange: ((Int) -> Void)?

    private let onEvent: (String, [String: Any]) -> Void
    private let onLoadImage: (String) -> Void
    private var requestedImages = Set<String>()
    private var toastToken = 0
    private var routeSeq = 0
    private var programmatic = false
    private var pendingWork: DispatchWorkItem?

    init(spec: NativePageSpec,
         onEvent: @escaping (String, [String: Any]) -> Void,
         onLoadImage: @escaping (String) -> Void) {
        self.root = spec
        self.onEvent = onEvent
        self.onLoadImage = onLoadImage
    }

    var depth: Int { path.count }

    func screen(_ route: NativePageRoute) -> NativePageScreen? { screens[route.id] }

    /// 当前最上面那一级网页页面的层级（原生二级页算它下面那一页）
    private var topLevel: Int {
        for route in path.reversed() {
            if let screen = screens[route.id] { return screen.level }
        }
        return root.level
    }

    // MARK: 路径

    private func push(_ screen: NativePageScreen) {
        routeSeq += 1
        screens[routeSeq] = screen
        programmatic = true
        path.append(NativePageRoute(id: routeSeq))
        programmatic = false
    }

    private func truncate(to count: Int) {
        guard count < path.count else { return }
        programmatic = true
        path = Array(path.prefix(max(0, count)))
        programmatic = false
    }

    private func pathChanged(from old: [NativePageRoute]) {
        let removed = old.filter { route in !path.contains(route) }
        // 先按被弹出页的类型判断，再清掉它们
        let poppedRemote = removed.contains { route in !(screens[route.id]?.local ?? true) }
        for route in removed { screens[route.id] = nil }
        onDepthChange?(path.count)
        guard !programmatic, poppedRemote else { return }
        // 用户点返回或侧滑弹出了网页页面（或还在加载的占位页）：让网页回到现在最上面的层级并刷新它
        finishPending()
        request("back", ["level": topLevel])
    }

    // MARK: 网页回传

    /// 网页回传的新页面：更深一级时推入，同级原地刷新，更浅时退回到那一级
    func apply(_ next: NativePageSpec) {
        finishPending()
        if next.level <= 0 {
            root = next
            truncate(to: 0)
        } else if let index = path.lastIndex(where: { route in
            guard let screen = screens[route.id] else { return false }
            return !screen.local && screen.level == next.level
        }) {
            screens[path[index].id] = .page(next)
            truncate(to: index + 1)
        } else {
            // 新的一级：保留所有更浅的页（含原生二级页），推入
            if let keep = path.lastIndex(where: { (screens[$0.id]?.level ?? 0) < next.level }) {
                truncate(to: keep + 1)
            } else {
                truncate(to: 0)
            }
            push(.page(next))
        }
    }

    /// 网页要求填写表单（编辑、新建）：推入原生表单页
    func presentForm(_ form: NativePageForm) {
        finishPending()
        // 还在加载的占位页让给表单
        if let last = path.last, case .loading? = screens[last.id] { truncate(to: path.count - 1) }
        push(.form(form, level: topLevel))
    }

    /// 只有提示、没有新页面的回执：收起占位页；提交成功的表单页退回
    func finishWithoutPage(error: Bool) {
        let wasLoading = loading
        finishPending()
        guard let last = path.last, let screen = screens[last.id] else { return }
        switch screen {
        case .loading:
            truncate(to: path.count - 1)
        case .form:
            if wasLoading && !error { truncate(to: path.count - 1) }
        default:
            break
        }
    }

    private func finishPending() {
        pendingWork?.cancel()
        pendingWork = nil
        busyRow = nil
        withAnimation(.easeOut(duration: 0.15)) { loading = false }
    }

    func showToast(_ message: String) {
        guard !message.isEmpty else { return }
        toastToken += 1
        let token = toastToken
        toast = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { [weak self] in
            guard let self, self.toastToken == token else { return }
            self.toast = nil
        }
    }

    func loadImage(_ id: String) {
        guard !id.isEmpty, images[id] == nil, !requestedImages.contains(id) else { return }
        requestedImages.insert(id)
        onLoadImage(id)
    }

    func setImage(_ id: String, _ image: UIImage?) {
        if let image { images[id] = image }
    }

    // MARK: 用户操作

    /// 发给网页并等待回传；超时（网页没有响应）时提示并收起占位页，不让页面一直卡住
    private func send(_ type: String, _ payload: [String: Any], row: String? = nil) {
        pendingWork?.cancel()
        busyRow = row
        withAnimation(.easeOut(duration: 0.15)) { loading = true }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.finishWithoutPage(error: true)
            self.alertMessage = self.root.timeoutText
        }
        pendingWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
        onEvent(type, payload)
    }

    func request(_ type: String, _ payload: [String: Any] = [:]) {
        if type == "back" {
            // 返回只是让网页同步层级并刷新那一页，界面已经退回，不显示加载
            onEvent(type, payload)
            return
        }
        send(type, payload)
    }

    func perform(_ action: NativePageAction, row: NativePageRow? = nil) {
        if !action.confirmTitle.isEmpty || !action.confirmMessage.isEmpty {
            confirming = NativePageConfirm(action: action)
        } else {
            run(action, row: row)
        }
    }

    func confirm(_ action: NativePageAction) {
        run(action, row: nil)
    }

    private func run(_ action: NativePageAction, row: NativePageRow?) {
        guard !loading else { return }
        if action.push {
            // 下一级页面：先推入占位页（标题用这一行），网页回传后原地换成真正的页面
            push(.loading(title: row?.title ?? action.title, level: topLevel + 1))
            }
        send("action", ["actionId": action.id], row: action.push ? nil : row?.id)
    }

    /// 点一行：一个操作直接执行；多个操作推入这一行的详情页，操作列在里面（代替隐藏的操作菜单）
    func tap(_ row: NativePageRow) {
        guard !row.actions.isEmpty, !loading else { return }
        if row.actions.count == 1 {
            perform(row.actions[0], row: row)
        } else {
            push(.row(row, level: topLevel))
            }
    }

    func openForm(_ form: NativePageForm) {
        push(.form(form, level: topLevel))
    }

    func back() {
        guard !path.isEmpty else { return }
        path.removeLast()
    }

    func close() { onEvent("close", [:]) }

    func filter(_ id: String, _ value: String) {
        send("filter", ["filterId": id, "value": value])
    }

    func submit(_ form: NativePageForm, values: [String: Any]) {
        send("submit", ["formId": form.id, "values": values])
    }

    func photo(_ actionId: String, base64: String) {
        send("action", ["actionId": actionId, "image": base64])
    }
}

// MARK: - 页面

/// 与住民设置同一种结构：根页与各级子页都是系统分组列表（insetGrouped），子页由 NavigationStack 推入，
/// 返回、左边缘侧滑都是系统导航的跟手动画。
struct NativePageView: View {
    @ObservedObject var model: NativePageModel

    /// 其它文件（管理后台 / 日记插件）需要通过这个 internal 初始化器创建页面
    init(model: NativePageModel) {
        self.model = model
    }

    var body: some View {
        NavigationStack(path: $model.path) {
            NativePageList(model: model, spec: model.root, isRoot: true)
                .navigationDestination(for: NativePageRoute.self) { route in
                    destination(route)
                }
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                Text(toast)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 28)
                    .transition(.opacity)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.toast)
        .alert(model.confirming?.action.confirmTitle ?? "", isPresented: Binding(
            get: { model.confirming != nil },
            set: { if !$0 { model.confirming = nil } }
        )) {
            if let confirm = model.confirming {
                Button(confirm.action.confirmButton.isEmpty ? confirm.action.title : confirm.action.confirmButton,
                       role: confirm.action.destructive ? ButtonRole.destructive : nil) {
                    model.confirming = nil
                    model.confirm(confirm.action)
                }
                Button(model.root.cancelTitle, role: .cancel) { model.confirming = nil }
            }
        } message: {
            Text(model.confirming?.action.confirmMessage ?? "")
        }
        .alert(model.alertMessage ?? "", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button(model.root.okTitle, role: .cancel) {}
        }
    }

    @ViewBuilder
    private func destination(_ route: NativePageRoute) -> some View {
        switch model.screen(route) {
        case .page(let spec)?:
            NativePageList(model: model, spec: spec, isRoot: false)
        case .loading(let title, _)?:
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
        case .row(let row, _)?:
            NativePageRowDetail(model: model, row: row)
        case .form(let form, _)?:
            NativeFormPage(form: form, model: model)
        case nil:
            Color(uiColor: .systemGroupedBackground).ignoresSafeArea()
        }
    }
}

/// 一页网页下发的内容：分组列表
private struct NativePageList: View {
    @ObservedObject var model: NativePageModel
    let spec: NativePageSpec
    let isRoot: Bool
    @State private var search = ""

    var body: some View {
        List {
            if !spec.subtitle.isEmpty {
                Section {
                    Text(spec.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if !spec.message.isEmpty {
                Section {
                    Label(spec.message, systemImage: "checkmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Color.green)
                }
            }
            if !spec.error.isEmpty {
                Section {
                    Label(spec.error, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Color.red)
                }
            }
            if !spec.tabs.isEmpty {
                Section {
                    tabsView
                }
            }
            if spec.loading {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            }
            ForEach(spec.sections) { section in
                sectionView(section)
            }
            if !spec.emptyText.isEmpty && spec.sections.isEmpty && !spec.loading {
                Section {
                    Text(spec.emptyText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            if !spec.buttons.isEmpty {
                Section {
                    ForEach(spec.buttons) { action in
                        buttonRow(action)
                    }
                }
            }
            if !spec.pagerText.isEmpty || !spec.pagerPrev.isEmpty || !spec.pagerNext.isEmpty {
                Section {
                    pager
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .modifier(NativePageSearch(enabled: !spec.searchPlaceholder.isEmpty, placeholder: spec.searchPlaceholder, text: $search) {
            model.filter("search", search.trimmingCharacters(in: .whitespaces))
        })
        .navigationTitle(spec.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isRoot {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        model.close()
                    } label: {
                        Image(systemName: "chevron.backward").font(.headline)
                    }
                    .accessibilityLabel(Text(spec.closeTitle))
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                if model.loading && model.busyRow == nil {
                    ProgressView()
                }
            }
        }
        .onAppear { search = spec.searchValue }
        .onChange(of: spec.id) { _, _ in search = spec.searchValue }
    }

    @ViewBuilder
    private var tabsView: some View {
        if spec.tabs.count <= 4 {
            Picker("", selection: Binding(
                get: { spec.selectedTab },
                set: { model.filter("tabs", $0) }
            )) {
                ForEach(spec.tabs) { option in
                    Text(option.title).tag(option.id)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(spec.tabs) { option in
                        NativeTagChip(title: option.title, selected: option.id == spec.selectedTab) {
                            model.filter("tabs", option.id)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
    }

    @ViewBuilder
    private func sectionView(_ section: NativePageSection) -> some View {
        Section {
            if !section.rows.isEmpty {
                ForEach(section.rows) { row in
                    NativePageRowButton(model: model, row: row)
                }
            } else if let calendar = section.calendar {
                NativeCalendarCard(calendar: calendar) { action in
                    model.request("action", ["actionId": action])
                }
            } else if let form = section.form {
                // 表单只显示当前值；“编辑”推入可编辑的表单页
                ForEach(form.fields) { field in
                    NativeReadOnlyField(field: field)
                }
                Button {
                    model.openForm(form)
                } label: {
                    HStack {
                        Text(form.openTitle)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
            } else if !section.images.isEmpty {
                NativeImageGrid(images: section.images, model: model)
            } else if !section.text.isEmpty {
                Text(section.text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } header: {
            if !section.title.isEmpty {
                Text(section.title)
            } else if let form = section.form, !form.title.isEmpty {
                Text(form.title)
            }
        } footer: {
            if let form = section.form, !form.message.isEmpty {
                Text(form.message)
            }
        }
    }

    @ViewBuilder
    private func buttonRow(_ action: NativePageAction) -> some View {
        if action.kind == "photo" {
            PhotosPicker(selection: Binding(get: { nil as PhotosPickerItem? }, set: { item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let image = UIImage(data: data),
                       let encoded = NativePageImage.encode(image) {
                        await MainActor.run { model.photo(action.id, base64: encoded) }
                    }
                }
            }), matching: .images) {
                Label(action.title, systemImage: "photo.on.rectangle")
            }
            .disabled(model.loading)
        } else {
            Button(role: action.destructive ? ButtonRole.destructive : nil) {
                model.perform(action)
            } label: {
                HStack {
                    Text(action.title)
                        .fontWeight(action.tone == "primary" ? .semibold : .regular)
                    Spacer()
                    if action.push {
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .disabled(model.loading)
        }
    }

    private var pager: some View {
        HStack(spacing: 8) {
            Button {
                model.request("action", ["actionId": spec.pagerPrev])
            } label: {
                Image(systemName: "chevron.backward").frame(width: 36, height: 36)
            }
            .buttonStyle(.borderless)
            .disabled(spec.pagerPrev.isEmpty || model.loading)
            Spacer()
            Text(spec.pagerText)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                model.request("action", ["actionId": spec.pagerNext])
            } label: {
                Image(systemName: "chevron.forward").frame(width: 36, height: 36)
            }
            .buttonStyle(.borderless)
            .disabled(spec.pagerNext.isEmpty || model.loading)
        }
    }
}

/// 有搜索框的页面用系统搜索栏（导航栏下方），提交时交给网页筛选
private struct NativePageSearch: ViewModifier {
    let enabled: Bool
    let placeholder: String
    @Binding var text: String
    let submit: () -> Void

    func body(content: Content) -> some View {
        if enabled {
            content
                .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(placeholder))
                .onSubmit(of: .search, submit)
                .onChange(of: text) { old, new in
                    // 点清除按钮：立即取消筛选
                    if new.isEmpty && !old.isEmpty { submit() }
                }
        } else {
            content
        }
    }
}

/// 列表里的一行：图片、标题与标签、说明；可点时行尾是箭头（加载时转圈）
private struct NativePageRowButton: View {
    @ObservedObject var model: NativePageModel
    let row: NativePageRow

    var body: some View {
        if row.actions.isEmpty {
            content
                .listRowBackground(row.selected ? Color.accentColor.opacity(0.12) : nil)
        } else {
            Button {
                model.tap(row)
            } label: {
                content
            }
            .disabled(model.loading)
            .listRowBackground(row.selected ? Color.accentColor.opacity(0.12) : nil)
            .accessibilityAddTraits(row.selected ? .isSelected : [])
        }
    }

    private var content: some View {
        HStack(alignment: .center, spacing: 12) {
            NativePageRowImage(model: model, row: row, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(row.title)
                        .font(.body)
                        .foregroundStyle(Color.primary)
                        .lineLimit(2)
                    if !row.badge.isEmpty {
                        NativePageBadge(text: row.badge, tone: row.badgeTone)
                    }
                }
                if !row.subtitle.isEmpty {
                    Text(row.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if !row.detail.isEmpty {
                    Text(row.detail)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(3)
                }
                if !row.chips.isEmpty {
                    Text(row.chips.map(\.text).joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            if model.busyRow == row.id {
                ProgressView()
            } else if !row.actions.isEmpty {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

private struct NativePageBadge: View {
    let text: String
    let tone: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch tone {
        case "danger": return .red
        case "warning": return .orange
        case "success": return .green
        case "primary": return .accentColor
        default: return .secondary
        }
    }
}

private struct NativePageRowImage: View {
    @ObservedObject var model: NativePageModel
    let row: NativePageRow
    let size: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
        if !row.protectedImage.isEmpty {
            if let image = model.images[row.protectedImage] {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(shape)
            } else {
                shape
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: size, height: size)
                    .overlay(Image(systemName: "photo").foregroundStyle(.tertiary))
                    .onAppear { model.loadImage(row.protectedImage) }
            }
        } else if let url = URL(string: row.image), url.scheme == "https" {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.primary.opacity(0.06)
            }
            .frame(width: size, height: size)
            .clipShape(shape)
        }
    }
}

/// 一行有多个操作时的二级页：上面是这一行的完整信息，下面逐个列出操作（危险操作红色，确认后执行）
private struct NativePageRowDetail: View {
    @ObservedObject var model: NativePageModel
    let row: NativePageRow

    var body: some View {
        List {
            Section {
                HStack(alignment: .top, spacing: 14) {
                    NativePageRowImage(model: model, row: row, size: 64)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(row.title)
                                .font(.headline)
                            if !row.badge.isEmpty {
                                NativePageBadge(text: row.badge, tone: row.badgeTone)
                            }
                        }
                        if !row.subtitle.isEmpty {
                            Text(row.subtitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 4)
                if !row.detail.isEmpty {
                    Text(row.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                if !row.chips.isEmpty {
                    NativeFlowLayout(spacing: 6, lineSpacing: 6) {
                        ForEach(row.chips) { chip in
                            Text(chip.text)
                                .font(.caption)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background((chip.tone == "primary" ? Color.accentColor : Color.primary).opacity(0.1), in: Capsule())
                                .foregroundStyle(chip.tone == "primary" ? Color.accentColor : Color.primary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            Section {
                ForEach(row.actions) { action in
                    Button(role: action.destructive ? ButtonRole.destructive : nil) {
                        model.perform(action, row: row)
                    } label: {
                        HStack {
                            Text(action.title)
                            Spacer()
                            if action.push {
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .disabled(model.loading)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(row.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if model.loading { ProgressView() }
            }
        }
    }
}

// MARK: - 表单

/// 内联卡片里的表单只显示当前值；点击后进入可编辑的表单页。
private struct NativeReadOnlyField: View {
    let field: NativePageField

    var body: some View {
        LabeledContent(field.label) {
            Text(display)
                .multilineTextAlignment(.trailing)
                .lineLimit(3)
        }
    }

    private var display: String {
        switch field.kind {
        case "toggle": return field.value.bool ? "✓" : "—"
        case "select":
            let id = field.value.text
            return field.options.first { $0.id == id }?.title ?? id
        case "multiselect":
            let selected = Set(field.value.list)
            return field.options.filter { selected.contains($0.id) }.map(\.title).joined(separator: "、")
        case "image":
            return field.value.text.isEmpty ? "—" : "✓"
        default: return field.value.text
        }
    }
}

/// 可编辑的表单页（推入页面栈，不再用全屏弹窗）：系统 Form，右上角提交，返回即取消
struct NativeFormPage: View {
    let form: NativePageForm
    @ObservedObject var model: NativePageModel
    @State private var values: [String: NativePageValue] = [:]

    /// 私有 @State 会让编译器合成的 memberwise init 变成 private，页面视图无法创建表单页。
    init(form: NativePageForm, model: NativePageModel) {
        self.form = form
        self.model = model
    }

    var body: some View {
        Form {
            if !form.message.isEmpty {
                Section {
                    Text(form.message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(form.fields) { field in
                fieldSection(field)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .disabled(model.loading)
        .navigationTitle(form.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if model.loading {
                    ProgressView()
                } else {
                    Button(form.submitTitle) {
                        model.submit(form, values: collect())
                    }
                    .font(.body.weight(.semibold))
                }
            }
        }
        .onAppear(perform: initialize)
    }

    private func initialize() {
        guard values.isEmpty else { return }
        for field in form.fields { values[field.id] = field.value }
    }

    @ViewBuilder
    private func fieldSection(_ field: NativePageField) -> some View {
        Section {
            switch field.kind {
            case "textarea":
                TextField(field.placeholder, text: textBinding(field.id), axis: .vertical)
                    .lineLimit(4...12)
            case "select":
                Picker(field.label, selection: textBinding(field.id)) {
                    ForEach(field.options) { option in
                        Text(option.title).tag(option.id)
                    }
                }
                .pickerStyle(.menu)
            case "multiselect":
                ForEach(field.options) { option in
                    let selected = values[field.id]?.list.contains(option.id) ?? false
                    Button {
                        var list = values[field.id]?.list ?? []
                        if let index = list.firstIndex(of: option.id) { list.remove(at: index) } else { list.append(option.id) }
                        values[field.id] = .list(list)
                    } label: {
                        HStack {
                            Text(option.title).foregroundStyle(Color.primary)
                            Spacer()
                            if selected {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            case "toggle":
                Toggle(field.label, isOn: boolBinding(field.id))
            case "date":
                DatePicker(field.label, selection: dateBinding(field.id), displayedComponents: .date)
            case "datetime":
                DatePicker(field.label, selection: dateBinding(field.id, includeTime: true), displayedComponents: [.date, .hourAndMinute])
            case "number":
                TextField(field.placeholder, text: textBinding(field.id))
                    .keyboardType(.decimalPad)
            case "image":
                imageField(field)
            case "info":
                Text(field.value.text)
                    .foregroundStyle(.secondary)
            default:
                TextField(field.placeholder, text: textBinding(field.id))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        } header: {
            // 开关、选择、日期的行内已经有标签
            if !["toggle", "select", "date", "datetime"].contains(field.kind) {
                Text(field.label)
            }
        } footer: {
            if !field.footer.isEmpty {
                Text(field.footer)
            }
        }
    }

    @ViewBuilder
    private func imageField(_ field: NativePageField) -> some View {
        HStack(spacing: 12) {
            Group {
                if let image = imageFor(field.id) {
                    Image(uiImage: image).resizable().scaledToFill()
                } else if let url = URL(string: values[field.id]?.text ?? ""), url.scheme == "https" {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Color.primary.opacity(0.06)
                    }
                } else {
                    Color.primary.opacity(0.06)
                        .overlay(Image(systemName: "photo").foregroundStyle(.tertiary))
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 8) {
                PhotosPicker(selection: Binding(
                    get: { nil as PhotosPickerItem? },
                    set: { item in
                        guard let item else { return }
                        Task {
                            if let data = try? await item.loadTransferable(type: Data.self),
                               let image = UIImage(data: data),
                               let encoded = NativePageImage.encode(image) {
                                await MainActor.run { values[field.id] = .text(encoded) }
                            }
                        }
                    }
                ), matching: .images) {
                    Text(model.root.pickImageTitle)
                }
                .buttonStyle(.borderless)
                if !(values[field.id]?.text ?? "").isEmpty {
                    Button(model.root.removeImageTitle, role: .destructive) {
                        values[field.id] = .text("")
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func imageFor(_ id: String) -> UIImage? {
        guard let text = values[id]?.text, !text.isEmpty, !text.hasPrefix("http") else { return nil }
        return NativePageImage.decode(text)
    }

    private func textBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { values[id]?.text ?? "" },
            set: { values[id] = .text($0) }
        )
    }

    private func boolBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { values[id]?.bool ?? false },
            set: { values[id] = .bool($0) }
        )
    }

    private func dateBinding(_ id: String, includeTime: Bool = false) -> Binding<Date> {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = includeTime ? "yyyy-MM-dd'T'HH:mm" : "yyyy-MM-dd"
        let current = formatter.date(from: values[id]?.text ?? "")
        return Binding(
            get: { current ?? Date() },
            set: { values[id] = .text(formatter.string(from: $0)) }
        )
    }

    private func collect() -> [String: Any] {
        var out: [String: Any] = [:]
        for field in form.fields {
            let value = values[field.id] ?? .none
            switch field.kind {
            case "number":
                if let number = Double(value.text) { out[field.id] = number } else { out[field.id] = value.text }
            case "toggle":
                out[field.id] = value.bool
            case "multiselect":
                out[field.id] = value.list
            default:
                out[field.id] = value.bridgeValue
            }
        }
        return out
    }
}

// MARK: - 图片与日历

private struct NativeImageGrid: View {
    let images: [NativePageImageItem]
    @ObservedObject var model: NativePageModel

    private let columns = [GridItem(.adaptive(minimum: 92), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(images) { item in
                ZStack(alignment: .topTrailing) {
                    Group {
                        if !item.protectedImage.isEmpty {
                            if let image = model.images[item.protectedImage] {
                                Image(uiImage: image).resizable().scaledToFill()
                            } else {
                                Color.primary.opacity(0.06)
                                    .onAppear { model.loadImage(item.protectedImage) }
                            }
                        } else if let url = URL(string: item.image), url.scheme == "https" {
                            AsyncImage(url: url) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                Color.primary.opacity(0.06)
                            }
                        } else {
                            Color.primary.opacity(0.06)
                        }
                    }
                    .frame(height: 92)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    if !item.caption.isEmpty {
                        Text(item.caption)
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(.regularMaterial, in: Capsule())
                            .padding(5)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard !item.actions.isEmpty else { return }
                    model.tap(NativePageRow(
                        id: item.id, title: item.caption, subtitle: "", detail: "",
                        image: item.image, protectedImage: item.protectedImage, badge: "", badgeTone: "",
                        chips: [], actions: item.actions, selected: false
                    ))
                }
            }
        }
        .padding(.vertical, 6)
    }
}

private struct NativeCalendarCard: View {
    let calendar: NativePageCalendar
    let action: (String) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Button {
                    if !calendar.previousAction.isEmpty { action(calendar.previousAction) }
                } label: {
                    Image(systemName: "chevron.left").frame(width: 34, height: 34)
                }
                .buttonStyle(.borderless)
                Spacer()
                Text(calendar.monthLabel).font(.headline)
                Spacer()
                Button {
                    if !calendar.nextAction.isEmpty { action(calendar.nextAction) }
                } label: {
                    Image(systemName: "chevron.right").frame(width: 34, height: 34)
                }
                .buttonStyle(.borderless)
            }
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(Array(calendar.weekdays.enumerated()), id: \.offset) { _, weekday in
                    Text(weekday)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                ForEach(calendar.days) { day in
                    if day.day == 0 {
                        Color.clear.frame(height: 42)
                    } else {
                        Button {
                            if !day.action.isEmpty { action(day.action) }
                        } label: {
                            VStack(spacing: 1) {
                                Text("\(day.day)").font(.subheadline)
                                if day.count > 0 {
                                    Text("\(day.count)").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color.accentColor)
                                } else if day.hasDraft {
                                    Circle().fill(Color.orange).frame(width: 4, height: 4)
                                } else {
                                    Color.clear.frame(width: 4, height: 4)
                                }
                            }
                            .foregroundStyle(day.selected ? Color.white : Color.primary)
                            .frame(maxWidth: .infinity, minHeight: 42)
                            .background(day.selected ? Color.accentColor : Color.clear, in: Circle().inset(by: 1))
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

enum NativePageImage {
    static func decode(_ base64: String) -> UIImage? {
        let text: String
        if let index = base64.firstIndex(of: ",") {
            text = String(base64[base64.index(after: index)...])
        } else {
            text = base64
        }
        guard let data = Data(base64Encoded: text, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }

    static func encode(_ image: UIImage, maxSide: CGFloat = 1600) -> String? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let ratio = min(1, maxSide / longest)
        let target = CGSize(width: max(1, (image.size.width * ratio).rounded()), height: max(1, (image.size.height * ratio).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: target))
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let jpeg = rendered.jpegData(compressionQuality: 0.85) else { return nil }
        return jpeg.base64EncodedString()
    }
}
