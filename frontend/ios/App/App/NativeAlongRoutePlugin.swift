import Capacitor
import SwiftUI
import UIKit

/// 本地 Capacitor 插件：iOS 原生“顺路吃”面板。
///
/// open({ id, theme, labels, modes, distances, categories, categoriesLoading, values }) -> { id, action: close|select, values }
/// update({ id, categories }) -> {}：面板先打开，分类目录读到后再补上（不等网络）
/// respond({ id, requestId, ok, message, state }) -> {}
/// close({ id }) -> {}
/// 事件 alongRouteEvent：{ id, type: submit|chooseRoute, requestId, values }
///
/// 网页负责解析高德行程、规划路线、在地图上画线、查询沿途地点与全部文案；
/// 原生只收集条件、展示网页格式化好的路线与地点，不接触凭证或任意 URL 请求。
@objc(NativeAlongRoutePlugin)
public class NativeAlongRoutePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAlongRoutePlugin"
    public let jsName = "NativeAlongRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise)
    ]

    private var host: UIViewController?
    private var pending: CAPPluginCall?
    private var requestID: String?
    private var model: NativeAlongRouteModel?
    private var finishing = false
    private var presenting = false
    private var queuedFinish: (action: String, values: [String: Any], animated: Bool)?
    private var closeCompletions: [() -> Void] = []
    private var loadingObservation: NSKeyValueObservation?
    private let sheetDelegate = AlongRouteSheetDelegate()

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "close", animated: false) }
        }
        sheetDelegate.onDismiss = { [weak self] in self?.finish(action: "close") }
    }

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), !id.isEmpty else {
                call.reject("Missing request id", "INVALID_ARGUMENT"); return
            }
            guard self.host == nil, let presenter = self.bridge?.viewController,
                  presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
                call.reject("Another screen is being presented", "BUSY"); return
            }
            let model = NativeAlongRouteModel(call: call) { [weak self] payload in
                guard let self, let id = self.requestID else { return }
                var data = payload
                data["id"] = id
                self.notifyListeners("alongRouteEvent", data: data)
            }
            model.onFinish = { [weak self] action, values in
                self?.finish(action: action, values: values)
            }
            let host = MapChromeHostingController(rootView: NativeAlongRouteView(model: model), dark: model.dark)
            host.modalPresentationStyle = .pageSheet
            if #available(iOS 26.0, *) {
                host.view.backgroundColor = .clear
            } else {
                host.view.backgroundColor = .systemGroupedBackground
            }
            if let sheet = host.sheetPresentationController {
                let compact = UISheetPresentationController.Detent.Identifier("alongRoute.compact")
                sheet.detents = [
                    .custom(identifier: compact) { context in context.maximumDetentValue * 0.52 },
                    .large()
                ]
                sheet.selectedDetentIdentifier = compact
                // 较小高度不压暗地图：规划后可在地图上比较路线，点下方方案开始找店
                sheet.largestUndimmedDetentIdentifier = compact
                sheet.prefersGrabberVisible = true
                sheet.prefersScrollingExpandsWhenScrolledToEdge = true
                model.onRoutesPlanned = { [weak host] in
                    guard let sheet = host?.sheetPresentationController,
                          sheet.selectedDetentIdentifier == .large else { return }
                    sheet.animateChanges { sheet.selectedDetentIdentifier = compact }
                }
            }
            host.presentationController?.delegate = self.sheetDelegate
            self.model = model
            self.host = host
            self.pending = call
            self.requestID = id
            self.presenting = true
            presenter.present(host, animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
                guard let self else { return }
                self.presenting = false
                if let queued = self.queuedFinish {
                    self.queuedFinish = nil
                    self.finish(action: queued.action, values: queued.values, animated: queued.animated)
                }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("id") == self.requestID else { call.resolve(); return }
            self.finish(action: "close", animated: false) { call.resolve() }
        }
    }

    /// 网页晚到的分类目录（打开面板时还没读到）
    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard call.getString("id") == self.requestID, let model = self.model,
                  let categories = call.getArray("categories", JSObject.self) else { return }
            model.setCategories(categories)
        }
    }

    /// 网页处理完规划 / 筛选后回传结果（按 requestId 对应，过期的回执忽略）
    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let requestId = call.getString("requestId") else { return }
            self.model?.finish(requestId: requestId, ok: call.getBool("ok", false),
                               message: String((call.getString("message") ?? "").prefix(200)),
                               state: call.getObject("state") ?? [:])
        }
    }

    private func finish(action: String, values: [String: Any] = [:], animated: Bool = true, completion: (() -> Void)? = nil) {
        guard let host else { completion?(); return }
        if let completion { closeCompletions.append(completion) }
        guard !finishing else { return }
        if presenting {
            queuedFinish = (action, values, animated)
            return
        }
        finishing = true
        let call = pending
        let id = requestID
        model?.cancelPending()
        let complete = { [weak self] in
            self?.host = nil
            self?.pending = nil
            self?.requestID = nil
            self?.model = nil
            self?.finishing = false
            call?.resolve(["id": id ?? "", "action": action, "values": values])
            let completions = self?.closeCompletions ?? []
            self?.closeCompletions.removeAll()
            completions.forEach { $0() }
        }
        if let presenter = host.presentingViewController {
            presenter.dismiss(animated: animated && !UIAccessibility.isReduceMotionEnabled, completion: complete)
        } else {
            complete()
        }
    }
}

private final class AlongRouteSheetDelegate: NSObject, UIAdaptivePresentationControllerDelegate {
    var onDismiss: (() -> Void)?

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onDismiss?()
    }
}

// MARK: - 状态

final class NativeAlongRouteModel: ObservableObject {
    struct ModeOption: Identifiable {
        let id: String
        let label: String
    }

    struct CategoryOption: Identifiable {
        let name: String
        let common: Bool
        let order: Int
        var id: String { name }
    }

    struct DistanceOption: Identifiable {
        let value: Int
        let label: String
        var id: Int { value }
    }

    struct RouteRow: Identifiable {
        let index: Int
        let title: String
        let detail: String
        var id: Int { index }
    }

    struct PlaceRow: Identifiable {
        let id: String
        let name: String
        let meta: String
        let matches: String
    }

    @Published var url: String
    @Published var mode: String
    @Published var query: String
    @Published var categories: [String]
    @Published var corridor: Int
    @Published var categoryQuery = ""
    @Published private(set) var trip: String?
    @Published private(set) var routes: [RouteRow] = []
    @Published private(set) var places: [PlaceRow] = []
    @Published private(set) var routesTitle: String?
    @Published private(set) var emptyText = ""
    @Published private(set) var submitTitle: String
    @Published private(set) var busy = false
    @Published var alertMessage: String?
    @Published private(set) var selectedRouteIndex: Int?

    let dark: Bool
    let tint: Color
    let modes: [ModeOption]
    let distances: [DistanceOption]
    private let labels: [String: String]
    @Published private var allCategories: [CategoryOption]
    @Published private(set) var categoriesLoading: Bool
    private let send: ([String: Any]) -> Void
    private var pendingRequest: (id: String, work: DispatchWorkItem)?

    var onFinish: ((String, [String: Any]) -> Void)?
    var onRoutesPlanned: (() -> Void)?

    init(call: CAPPluginCall, send: @escaping ([String: Any]) -> Void) {
        self.send = send
        let labels = Self.strings(call.getObject("labels"))
        self.labels = labels
        let theme = call.getObject("theme") ?? [:]
        dark = (theme["dark"] as? Bool) ?? call.getBool("dark", false)
        tint = Color(uiColor: UIColor(cssHex: theme["primary"] as? String ?? "") ?? .systemPink)
        modes = (call.getArray("modes", JSObject.self) ?? []).compactMap { item -> ModeOption? in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            return ModeOption(id: String(id.prefix(16)), label: item["label"] as? String ?? id)
        }
        distances = (call.getArray("distances", JSObject.self) ?? []).compactMap { item -> DistanceOption? in
            guard let value = (item["value"] as? NSNumber)?.intValue, value > 0 else { return nil }
            return DistanceOption(value: value, label: item["label"] as? String ?? "\(value)")
        }
        allCategories = Self.parseCategories(call.getArray("categories", JSObject.self) ?? [])
        categoriesLoading = call.getBool("categoriesLoading", false)
        let values = call.getObject("values") ?? [:]
        url = String((values["url"] as? String ?? "").prefix(2048))
        let rawMode = values["mode"] as? String ?? "driving"
        mode = Self.modeIDs.contains(rawMode) ? rawMode : "driving"
        query = String((values["query"] as? String ?? "").prefix(100))
        categories = (values["categories"] as? JSArray ?? []).compactMap { $0 as? String }.map { String($0.prefix(24)) }
        let rawCorridor = (values["corridorMeters"] as? NSNumber)?.intValue ?? 1000
        corridor = Self.corridorValues.contains(rawCorridor) ? rawCorridor : 1000
        submitTitle = Self.text(labels, "planAndSearch", "规划路线并找店")
    }

    private static func parseCategories(_ list: [JSObject]) -> [CategoryOption] {
        list.compactMap { item -> CategoryOption? in
            guard let name = item["name"] as? String, !name.isEmpty else { return nil }
            return CategoryOption(name: String(name.prefix(24)), common: (item["common"] as? Bool) ?? false,
                                  order: (item["order"] as? NSNumber)?.intValue ?? 0)
        }.sorted { left, right in
            if left.common != right.common { return left.common }
            if left.order != right.order { return left.order < right.order }
            return left.name < right.name
        }
    }

    func setCategories(_ list: [JSObject]) {
        allCategories = Self.parseCategories(list)
        categoriesLoading = false
    }

    private static let modeIDs: Set<String> = ["driving", "transit", "walking", "riding"]
    private static let corridorValues: Set<Int> = [500, 1000, 2000, 3000]

    private static func strings(_ object: JSObject?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in object ?? [:] {
            if let text = value as? String { out[key] = text }
        }
        return out
    }

    private static func text(_ labels: [String: String], _ key: String, _ fallback: String) -> String {
        guard let value = labels[key], !value.isEmpty else { return fallback }
        return value
    }

    /// 网页下发的文案；缺失时用中文兜底
    func text(_ key: String, _ fallback: String) -> String {
        Self.text(labels, key, fallback)
    }

    var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canSubmit: Bool { !busy && !trimmedURL.isEmpty }

    var visibleCategories: [CategoryOption] {
        let search = categoryQuery.trimmingCharacters(in: .whitespaces)
        guard !search.isEmpty else {
            return Array(allCategories.filter(\.common).prefix(10))
        }
        return Array(allCategories.filter { $0.name.localizedCaseInsensitiveContains(search) }.prefix(20))
    }

    func symbol(for mode: String) -> String {
        switch mode {
        case "transit": return "bus.fill"
        case "walking": return "figure.walk"
        case "riding": return "bicycle"
        default: return "car.fill"
        }
    }

    func toggleCategory(_ name: String) {
        if let index = categories.firstIndex(of: name) {
            categories.remove(at: index)
        } else if categories.count < 12 {
            categories.append(name)
        }
    }

    // MARK: 请求

    private var values: [String: Any] {
        [
            "url": trimmedURL,
            "mode": mode,
            "query": query.trimmingCharacters(in: .whitespacesAndNewlines),
            "categories": categories,
            "corridorMeters": corridor
        ]
    }

    private func start(_ type: String, extra: [String: Any] = [:], timeout seconds: Double = 45) {
        guard !busy else { return }
        let requestId = UUID().uuidString
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pendingRequest?.id == requestId else { return }
            self.pendingRequest = nil
            self.busy = false
            self.alertMessage = self.text("searchFailed", "查找顺路地点失败")
        }
        pendingRequest = (requestId, work)
        busy = true
        var payload: [String: Any] = ["type": type, "requestId": requestId, "values": values]
        for (key, value) in extra { payload[key] = value }
        send(payload)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func submit() {
        guard !busy else { return }
        guard !trimmedURL.isEmpty else {
            alertMessage = text("pasteLinkFirst", "请先粘贴高德地图的行程分享链接")
            return
        }
        start("submit")
    }

    func chooseRoute(_ index: Int) {
        guard !busy else { return }
        var payload = values
        payload["index"] = index
        start("chooseRoute", extra: ["values": payload])
    }

    func selectPlace(_ id: String) {
        guard !busy else { return }
        onFinish?("select", ["placeId": id])
    }

    func requestClose() {
        onFinish?("close", [:])
    }

    func finish(requestId: String, ok: Bool, message: String, state: JSObject) {
        guard let entry = pendingRequest, entry.id == requestId else { return }
        entry.work.cancel()
        pendingRequest = nil
        busy = false
        guard ok else {
            alertMessage = message.isEmpty ? text("searchFailed", "查找顺路地点失败") : message
            return
        }
        apply(state)
        if !routes.isEmpty && places.isEmpty {
            onRoutesPlanned?()
        }
    }

    func cancelPending() {
        pendingRequest?.work.cancel()
        pendingRequest = nil
        busy = false
    }

    private func apply(_ state: JSObject) {
        if let value = state["trip"] as? String, !value.isEmpty { trip = value }
        if let value = state["mode"] as? String, Self.modeIDs.contains(value) { mode = value }
        if let value = state["routesTitle"] as? String { routesTitle = value.isEmpty ? nil : value }
        if let value = state["emptyText"] as? String { emptyText = value }
        if let value = state["submitTitle"] as? String, !value.isEmpty { submitTitle = value }
        if let value = (state["selectedRouteIndex"] as? NSNumber)?.intValue { selectedRouteIndex = value }
        routes = (state["routes"] as? JSArray ?? []).compactMap { entry -> RouteRow? in
            guard let item = entry as? JSObject,
                  let index = (item["index"] as? NSNumber)?.intValue else { return nil }
            return RouteRow(index: index,
                            title: item["title"] as? String ?? "\(index + 1)",
                            detail: item["detail"] as? String ?? "")
        }
        places = (state["places"] as? JSArray ?? []).compactMap { entry -> PlaceRow? in
            guard let item = entry as? JSObject,
                  let id = item["id"] as? String, !id.isEmpty,
                  let name = item["name"] as? String, !name.isEmpty else { return nil }
            return PlaceRow(id: id, name: name,
                            meta: item["meta"] as? String ?? "",
                            matches: item["matches"] as? String ?? "")
        }
    }
}

// MARK: - 页面

private struct NativeAlongRouteView: View {
    @ObservedObject var model: NativeAlongRouteModel

    /// 系统表单：行程、出行方式、想吃什么、标签、距离各是一组，下面是方案与沿途地点；
    /// 面板底色交给系统（半屏玻璃、全屏不透明，与地点卡片相同）。
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(model.text("shareLinkPlaceholder", "粘贴 surl.amap.com/..."), text: $model.url)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.go)
                        .onSubmit { model.submit() }
                        .nativeSheetRow()
                } header: {
                    Text(model.text("shareLink", "高德行程分享"))
                } footer: {
                    if let trip = model.trip, !trip.isEmpty {
                        Text(trip).lineLimit(2)
                    }
                }

                Section {
                    Picker(model.text("travelMode", "出行方式"), selection: $model.mode) {
                        ForEach(model.modes) { option in
                            Text(option.label).tag(option.id)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    .nativeSheetRow()
                } header: {
                    Text(model.text("travelMode", "出行方式"))
                }

                Section {
                    TextField(model.text("wantPlaceholder", "例如：火锅、想吃辣的、奶茶"), text: $model.query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .nativeSheetRow()
                } header: {
                    Text(model.text("want", "想吃什么"))
                }

                tagsSection

                Section {
                    Picker(model.text("maxDistance", "离路线最远"), selection: $model.corridor) {
                        ForEach(model.distances) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                    .pickerStyle(.menu)
                    .nativeSheetRow()
                    Button {
                        model.submit()
                    } label: {
                        HStack(spacing: 8) {
                            if model.busy {
                                ProgressView()
                            }
                            Text(model.busy ? model.text("searching", "正在规划或筛选…") : model.submitTitle)
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(!model.canSubmit)
                    .nativeSheetRow()
                }

                if !model.routes.isEmpty && model.places.isEmpty {
                    routesSection
                }
                if !model.places.isEmpty {
                    placesSection
                } else if !model.emptyText.isEmpty && !model.busy {
                    Section {
                        Text(model.emptyText)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .nativeSheetRow()
                    }
                }
            }
            .nativeSheetForm()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(model.text("title", "顺路吃"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        model.requestClose()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel(Text(model.text("close", "关闭顺路吃")))
                }
            }
        }
        .preferredColorScheme(model.dark ? .dark : .light)
        .tint(model.tint)
        .alert(model.alertMessage ?? "", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button(model.text("ok", "好"), role: .cancel) {}
        }
    }

    /// 标签：搜索行 + 一行可换行的标签（已选的在前，可点掉）
    private var tagsSection: some View {
        let visible = model.visibleCategories.filter { !model.categories.contains($0.name) }
        let searching = !model.categoryQuery.trimmingCharacters(in: .whitespaces).isEmpty
        return Section {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                TextField(model.text("tagSearch", "搜索全部标签"), text: $model.categoryQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .nativeSheetRow()
            if !model.categories.isEmpty || !visible.isEmpty {
                NativeFlowLayout(spacing: 8, lineSpacing: 8) {
                    ForEach(model.categories, id: \.self) { name in
                        NativeTagChip(title: name, selected: true, tint: model.tint, symbol: "xmark") {
                            model.toggleCategory(name)
                        }
                    }
                    ForEach(visible) { option in
                        NativeTagChip(title: option.name, tint: model.tint) {
                            model.toggleCategory(option.name)
                        }
                    }
                }
                .padding(.vertical, 4)
                .nativeSheetRow()
            }
        } header: {
            Text(model.text("tags", "标签"))
        } footer: {
            if model.categoriesLoading && !searching {
                Text(model.text("tagsLoading", "正在读取标签…"))
            } else if visible.isEmpty && searching {
                Text(model.text("noMatchingTags", "没有找到匹配标签"))
            } else {
                Text(searching ? model.text("matchingTags", "匹配的标签") : model.text("frequentTags", "常用标签"))
            }
        }
    }

    private var routesSection: some View {
        Section {
            ForEach(model.routes) { route in
                let selected = model.selectedRouteIndex == route.index
                Button {
                    model.chooseRoute(route.index)
                } label: {
                    HStack(spacing: 10) {
                        Text(route.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.primary)
                        Spacer(minLength: 8)
                        Text(route.detail)
                            .font(.subheadline)
                            .foregroundStyle(selected ? model.tint : .secondary)
                            .lineLimit(1)
                        if selected {
                            Image(systemName: "checkmark")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(model.tint)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .disabled(model.busy)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .nativeSheetRow()
            }
        } header: {
            if let title = model.routesTitle, !title.isEmpty {
                Text(title)
            }
        }
    }

    private var placesSection: some View {
        Section {
            ForEach(Array(model.places.enumerated()), id: \.element.id) { index, place in
                Button {
                    model.selectPlace(place.id)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1)")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color.white)
                            .frame(width: 24, height: 24)
                            .background(model.tint, in: Circle())
                        VStack(alignment: .leading, spacing: 3) {
                            Text(place.name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.primary)
                                .lineLimit(1)
                            if !place.meta.isEmpty {
                                Text(place.meta)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            if !place.matches.isEmpty {
                                Text(place.matches)
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 6)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .disabled(model.busy)
                .nativeSheetRow()
            }
        } header: {
            if let title = model.routesTitle, !title.isEmpty {
                Text(title)
            }
        }
    }
}
