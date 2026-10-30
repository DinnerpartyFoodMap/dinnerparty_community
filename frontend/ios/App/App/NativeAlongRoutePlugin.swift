import Capacitor
import SwiftUI
import UIKit

/// 本地 Capacitor 插件：iOS 原生“顺路吃”面板。
///
/// open({ id, theme, labels, modes, distances, categories, values }) -> { id, action: close|select, values }
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
    private let allCategories: [CategoryOption]
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
        modes = (call.getArray("modes", JSObject.self) ?? []).compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            return ModeOption(id: String(id.prefix(16)), label: item["label"] as? String ?? id)
        }
        distances = (call.getArray("distances", JSObject.self) ?? []).compactMap { item in
            guard let value = (item["value"] as? NSNumber)?.intValue, value > 0 else { return nil }
            return DistanceOption(value: value, label: item["label"] as? String ?? "\(value)")
        }
        allCategories = (call.getArray("categories", JSObject.self) ?? []).compactMap { item in
            guard let name = item["name"] as? String, !name.isEmpty else { return nil }
            return CategoryOption(name: String(name.prefix(24)), common: (item["common"] as? Bool) ?? false,
                                  order: (item["order"] as? NSNumber)?.intValue ?? 0)
        }.sorted { left, right in
            if left.common != right.common { return left.common }
            if left.order != right.order { return left.order < right.order }
            return left.name < right.name
        }
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
        routes = (state["routes"] as? JSArray ?? []).compactMap { entry in
            guard let item = entry as? JSObject,
                  let index = (item["index"] as? NSNumber)?.intValue else { return nil }
            return RouteRow(index: index,
                            title: item["title"] as? String ?? "\(index + 1)",
                            detail: item["detail"] as? String ?? "")
        }
        places = (state["places"] as? JSArray ?? []).compactMap { entry in
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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    formCard
                    if !model.routes.isEmpty && model.places.isEmpty {
                        routesCard
                    }
                    if !model.places.isEmpty {
                        placesCard
                    } else if !model.emptyText.isEmpty && !model.busy {
                        NativeGlassCard(padding: 16) {
                            Text(model.emptyText)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(NativeSheetBackground().ignoresSafeArea())
            .navigationTitle(model.text("title", "顺路吃"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        model.requestClose()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .bold))
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

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private var formCard: some View {
        NativeGlassCard(padding: 16) {
            VStack(alignment: .leading, spacing: 14) {
                sectionTitle(model.text("shareLink", "高德行程分享"))
                TextField(model.text("shareLinkPlaceholder", "粘贴 surl.amap.com/..."), text: $model.url)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit { model.submit() }
                    .nativeFieldBackground()
                if let trip = model.trip, !trip.isEmpty {
                    Text(trip)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                sectionTitle(model.text("travelMode", "出行方式"))
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                    ForEach(model.modes) { option in
                        modeButton(option)
                    }
                }

                sectionTitle(model.text("want", "想吃什么"))
                TextField(model.text("wantPlaceholder", "例如：火锅、想吃辣的、奶茶"), text: $model.query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .nativeFieldBackground()

                sectionTitle(model.text("tags", "标签"))
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    TextField(model.text("tagSearch", "搜索全部标签"), text: $model.categoryQuery)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .nativeFieldBackground()

                let visible = model.visibleCategories
                if !model.categories.isEmpty || !visible.isEmpty {
                    NativeFlowLayout(spacing: 8, lineSpacing: 8) {
                        ForEach(model.categories, id: \.self) { name in
                            Button {
                                model.toggleCategory(name)
                            } label: {
                                Text(name + " ×")
                                    .font(.caption)
                                    .nativeChip(selected: true, tint: model.tint)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(model.text("tagSearch", "标签") + "：" + name))
                        }
                        ForEach(visible) { option in
                            if !model.categories.contains(option.name) {
                                Button {
                                    model.toggleCategory(option.name)
                                } label: {
                                    Text(option.name)
                                        .font(.caption)
                                        .nativeChip()
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    if visible.isEmpty && !model.categoryQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                        Text(model.text("noMatchingTags", "没有找到匹配标签"))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                HStack {
                    sectionTitle(model.text("maxDistance", "离路线最远"))
                    Spacer()
                    Picker("", selection: $model.corridor) {
                        ForEach(model.distances) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(model.tint)
                }

                Button {
                    model.submit()
                } label: {
                    HStack(spacing: 8) {
                        if model.busy {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "fork.knife")
                        }
                        Text(model.busy ? model.text("searching", "正在规划或筛选…") : model.submitTitle)
                            .font(.body.weight(.semibold))
                    }
                    .foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background(model.tint.opacity(model.canSubmit ? 1 : 0.5), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!model.canSubmit)
            }
        }
    }

    private func modeButton(_ option: NativeAlongRouteModel.ModeOption) -> some View {
        let selected = model.mode == option.id
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return Button {
            model.mode = option.id
        } label: {
            VStack(spacing: 4) {
                Image(systemName: model.symbol(for: option.id))
                    .font(.system(size: 17))
                Text(option.label)
                    .font(.caption2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(selected ? model.tint.opacity(0.16) : Color.primary.opacity(0.06), in: shape)
            .overlay(shape.strokeBorder(selected ? model.tint : Color.primary.opacity(0.12), lineWidth: selected ? 1.5 : 1))
            .foregroundStyle(selected ? model.tint : Color.primary)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var routesCard: some View {
        NativeGlassCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                if let title = model.routesTitle, !title.isEmpty {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                ForEach(model.routes) { route in
                    routeButton(route)
                }
            }
        }
    }

    private func routeButton(_ route: NativeAlongRouteModel.RouteRow) -> some View {
        let selected = model.selectedRouteIndex == route.index
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        return Button {
            model.chooseRoute(route.index)
        } label: {
            HStack(spacing: 10) {
                Text(route.title)
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                Text(route.detail)
                    .font(.caption)
                    .foregroundStyle(selected ? model.tint : .secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(selected ? model.tint.opacity(0.14) : Color.primary.opacity(0.05), in: shape)
            .overlay(shape.strokeBorder(selected ? model.tint : Color.primary.opacity(0.08), lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(model.busy)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var placesCard: some View {
        NativeGlassCard(padding: 10) {
            VStack(alignment: .leading, spacing: 0) {
                if let title = model.routesTitle, !title.isEmpty {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.top, 4)
                        .padding(.bottom, 6)
                }
                let items = Array(model.places.enumerated())
                ForEach(items, id: \.element.id) { index, place in
                    Button {
                        model.selectPlace(place.id)
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Color.white)
                                .frame(width: 24, height: 24)
                                .background(model.tint, in: Circle())
                            VStack(alignment: .leading, spacing: 3) {
                                Text(place.name)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                if !place.meta.isEmpty {
                                    Text(place.meta)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                if !place.matches.isEmpty {
                                    Text(place.matches)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: 6)
                            Image(systemName: "mappin.circle.fill")
                                .font(.system(size: 18))
                                .foregroundStyle(model.tint)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.busy)
                    if index < items.count - 1 {
                        Divider().padding(.leading, 42)
                    }
                }
            }
        }
    }
}
