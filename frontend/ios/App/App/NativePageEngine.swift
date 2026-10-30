import SwiftUI
import UIKit
import PhotosUI
import Capacitor

/// 原生页面引擎：网页下发声明式页面模型，SwiftUI 负责玻璃界面、输入与动作。
/// 管理后台与日记 · 同好共用；所有账号请求、权限与业务规则仍在网页层。
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

    static let empty = NativePageSpec(
        id: "empty", title: "", subtitle: "", message: "", error: "", emptyText: "",
        canGoBack: false, searchPlaceholder: "", searchValue: "", tabs: [], selectedTab: "",
        sections: [], buttons: [], pagerText: "", pagerPrev: "", pagerNext: "",
        loading: true, backTitle: "返回", closeTitle: "关闭"
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
        (value as? JSArray ?? []).compactMap { entry in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            return NativePageOption(id: id, title: item["title"] as? String ?? id)
        }
    }

    static func actions(_ value: Any?) -> [NativePageAction] {
        (value as? JSArray ?? []).compactMap { entry in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            let confirm = item["confirm"] as? JSObject
            return NativePageAction(
                id: id,
                title: item["title"] as? String ?? id,
                tone: item["tone"] as? String ?? "",
                kind: item["kind"] as? String ?? "action",
                confirmTitle: confirm?["title"] as? String ?? "",
                confirmMessage: confirm?["message"] as? String ?? "",
                confirmButton: confirm?["button"] as? String ?? (item["title"] as? String ?? "")
            )
        }
    }

    static func chips(_ value: Any?) -> [NativePageChip] {
        (value as? JSArray ?? []).enumerated().compactMap { index, entry in
            guard let item = entry as? JSObject else { return nil }
            let text = item["text"] as? String ?? ""
            guard !text.isEmpty else { return nil }
            return NativePageChip(id: "\(index)-\(text)", text: text, tone: item["tone"] as? String ?? "")
        }
    }

    static func fields(_ value: Any?) -> [NativePageField] {
        (value as? JSArray ?? []).compactMap { entry in
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
        (value as? JSArray ?? []).compactMap { entry in
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
        (value as? JSArray ?? []).compactMap { entry in
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
        let days = (item["days"] as? JSArray ?? []).enumerated().compactMap { index, entry -> NativeCalendarDay? in
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
        return NativePageSpec(
            id: item["id"] as? String ?? "page-\(UUID().uuidString)",
            title: item["title"] as? String ?? "",
            subtitle: item["subtitle"] as? String ?? "",
            message: item["message"] as? String ?? "",
            error: item["error"] as? String ?? "",
            emptyText: item["empty"] as? String ?? "",
            canGoBack: item["canGoBack"] as? Bool ?? false,
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
            closeTitle: item["closeTitle"] as? String ?? "关闭"
        )
    }
}

// MARK: - 状态

struct NativePageConfirm: Identifiable {
    let id = UUID()
    let action: NativePageAction
}

final class NativePageModel: ObservableObject {
    @Published var spec: NativePageSpec
    @Published var loading = false
    @Published var toast: String?
    @Published var alertMessage: String?
    @Published var form: NativePageForm?
    @Published var images: [String: UIImage] = [:]
    @Published var confirming: NativePageConfirm?
    @Published var actionSheet: NativePageRow?

    private let onEvent: (String, [String: Any]) -> Void
    private let onLoadImage: (String) -> Void
    private var requestedImages = Set<String>()
    private var toastToken = 0

    init(spec: NativePageSpec,
         onEvent: @escaping (String, [String: Any]) -> Void,
         onLoadImage: @escaping (String) -> Void) {
        self.spec = spec
        self.onEvent = onEvent
        self.onLoadImage = onLoadImage
    }

    func apply(_ next: NativePageSpec) {
        spec = next
        loading = false
    }

    func setLoading(_ value: Bool) {
        withAnimation(.easeOut(duration: 0.15)) { loading = value }
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

    func request(_ type: String, _ payload: [String: Any] = [:]) {
        onEvent(type, payload)
    }

    func perform(_ action: NativePageAction) {
        if !action.confirmTitle.isEmpty || !action.confirmMessage.isEmpty {
            confirming = NativePageConfirm(action: action)
        } else {
            request("action", ["actionId": action.id])
        }
    }

    func confirm(_ action: NativePageAction) {
        request("action", ["actionId": action.id])
    }

    func tap(_ row: NativePageRow) {
        guard !row.actions.isEmpty else { return }
        if row.actions.count == 1 {
            perform(row.actions[0])
        } else {
            actionSheet = row
        }
    }

    func back() { request("back") }
    func close() { request("close") }

    func filter(_ id: String, _ value: String) {
        request("filter", ["filterId": id, "value": value])
    }

    func submit(_ form: NativePageForm, values: [String: Any]) {
        request("submit", ["formId": form.id, "values": values])
    }

    func photo(_ actionId: String, base64: String) {
        request("action", ["actionId": actionId, "image": base64])
    }
}

// MARK: - 页面

struct NativePageView: View {
    @ObservedObject var model: NativePageModel
    @State private var search = ""
    @State private var searchInitialized = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    header
                    searchField
                    tabs
                    if !model.spec.message.isEmpty {
                        notice(model.spec.message, tone: "success", close: false)
                    }
                    if !model.spec.error.isEmpty {
                        notice(model.spec.error, tone: "error", close: false)
                    }
                    ForEach(model.spec.sections) { section in
                        sectionView(section)
                    }
                    if !model.spec.emptyText.isEmpty && model.spec.sections.isEmpty {
                        NativeGlassCard(padding: 16) {
                            Text(model.spec.emptyText)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                        }
                    }
                    buttons
                    pager
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(NativeSheetBackground().ignoresSafeArea())
            .navigationTitle(model.spec.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        if model.spec.canGoBack {
                            model.back()
                        } else {
                            model.close()
                        }
                    } label: {
                        Image(systemName: "chevron.backward")
                            .font(.headline)
                    }
                    .accessibilityLabel(Text(model.spec.canGoBack ? model.spec.backTitle : model.spec.closeTitle))
                }
            }
        }
        .preferredColorScheme(nil)
        .overlay {
            if model.loading {
                ZStack {
                    Color.black.opacity(0.08).ignoresSafeArea()
                    ProgressView()
                        .padding(20)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
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
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.toast)
        .sheet(item: $model.form) { form in
            NativeFormSheet(form: form, model: model)
                .presentationDetents([.large])
                .presentationBackground(.clear)
        }
        .confirmationDialog(
            model.actionSheet?.title ?? "",
            isPresented: Binding(get: { model.actionSheet != nil }, set: { if !$0 { model.actionSheet = nil } }),
            titleVisibility: .visible
        ) {
            if let row = model.actionSheet {
                ForEach(row.actions) { action in
                    Button(role: action.destructive ? .destructive : nil) {
                        model.actionSheet = nil
                        model.perform(action)
                    } label: {
                        Text(action.title)
                    }
                }
            }
            Button(model.spec.closeTitle, role: .cancel) { model.actionSheet = nil }
        }
        .alert(model.confirming?.action.confirmTitle ?? "", isPresented: Binding(
            get: { model.confirming != nil },
            set: { if !$0 { model.confirming = nil } }
        )) {
            if let confirm = model.confirming {
                Button(confirm.action.confirmButton.isEmpty ? confirm.action.title : confirm.action.confirmButton,
                       role: confirm.action.destructive ? .destructive : nil) {
                    model.confirming = nil
                    model.confirm(confirm.action)
                }
                Button(model.spec.closeTitle, role: .cancel) { model.confirming = nil }
            }
        } message: {
            Text(model.confirming?.action.confirmMessage ?? "")
        }
        .alert(model.alertMessage ?? "", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button("好", role: .cancel) {}
        }
        .onAppear {
            guard !searchInitialized else { return }
            searchInitialized = true
            search = model.spec.searchValue
        }
        .onChange(of: model.spec.id) { _, _ in
            search = model.spec.searchValue
        }
    }

    @ViewBuilder
    private var header: some View {
        if !model.spec.subtitle.isEmpty {
            NativeGlassCard(padding: 14) {
                Text(model.spec.subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private var searchField: some View {
        if !model.spec.searchPlaceholder.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                TextField(model.spec.searchPlaceholder, text: $search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { model.filter("search", search.trimmingCharacters(in: .whitespaces)) }
                if !search.isEmpty {
                    Button {
                        search = ""
                        model.filter("search", "")
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .nativeFieldBackground()
        }
    }

    @ViewBuilder
    private var tabs: some View {
        if !model.spec.tabs.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.spec.tabs) { option in
                        let selected = option.id == model.spec.selectedTab
                        Button {
                            model.filter("tabs", option.id)
                        } label: {
                            Text(option.title)
                                .font(.caption.weight(selected ? .semibold : .regular))
                                .nativeChip(selected: selected, tint: .accentColor)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    @ViewBuilder
    private func sectionView(_ section: NativePageSection) -> some View {
        if !section.rows.isEmpty {
            NativeGlassCard(padding: 10) {
                VStack(alignment: .leading, spacing: 0) {
                    if !section.title.isEmpty {
                        Text(section.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.top, 4)
                            .padding(.bottom, 6)
                    }
                    ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                        rowView(row)
                        if index < section.rows.count - 1 {
                            Divider().padding(.leading, row.protectedImage.isEmpty && row.image.isEmpty ? 8 : 62)
                        }
                    }
                }
            }
        } else if let calendar = section.calendar {
            NativeCalendarCard(calendar: calendar) { action in
                model.request("action", ["actionId": action])
            }
        } else if let form = section.form {
            NativeInlineForm(form: form, model: model)
        } else if !section.images.isEmpty {
            NativeImageGrid(images: section.images, model: model)
        } else if !section.text.isEmpty {
            NativeGlassCard(padding: 14) {
                Text(section.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func rowView(_ row: NativePageRow) -> some View {
        Button {
            model.tap(row)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                rowImage(row)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(row.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        if !row.badge.isEmpty {
                            Text(row.badge)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(badgeColor(row.badgeTone).opacity(0.14), in: Capsule())
                                .foregroundStyle(badgeColor(row.badgeTone))
                        }
                    }
                    if !row.subtitle.isEmpty {
                        Text(row.subtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    if !row.detail.isEmpty {
                        Text(row.detail)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(3)
                    }
                    if !row.chips.isEmpty {
                        NativeFlowLayout(spacing: 6, lineSpacing: 6) {
                            ForEach(row.chips) { chip in
                                Text(chip.text)
                                    .font(.caption2)
                                    .nativeChip(selected: chip.tone == "primary", tint: .accentColor)
                            }
                        }
                        .padding(.top, 2)
                    }
                }
                Spacer(minLength: 4)
                if !row.actions.isEmpty {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 18))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .background(row.selected ? Color.accentColor.opacity(0.1) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(row.actions.isEmpty)
    }

    @ViewBuilder
    private func rowImage(_ row: NativePageRow) -> some View {
        if !row.protectedImage.isEmpty {
            if let image = model.images[row.protectedImage] {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 48, height: 48)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: 48, height: 48)
                    .overlay(Image(systemName: "photo").foregroundStyle(.tertiary))
                    .onAppear { model.loadImage(row.protectedImage) }
            }
        } else if let url = URL(string: row.image), url.scheme == "https" {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.primary.opacity(0.06)
            }
            .frame(width: 48, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    @ViewBuilder
    private var buttons: some View {
        if !model.spec.buttons.isEmpty {
            NativeGlassCard(padding: 12) {
                VStack(spacing: 8) {
                    ForEach(model.spec.buttons) { action in
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
                                actionLabel(action)
                            }
                        } else {
                            Button {
                                model.perform(action)
                            } label: {
                                actionLabel(action)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private func actionLabel(_ action: NativePageAction) -> some View {
        Text(action.title)
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 40)
            .nativeChip(selected: action.tone == "primary", tint: .accentColor)
    }

    @ViewBuilder
    private var pager: some View {
        if !model.spec.pagerText.isEmpty || !model.spec.pagerPrev.isEmpty || !model.spec.pagerNext.isEmpty {
            HStack(spacing: 8) {
                if !model.spec.pagerPrev.isEmpty {
                    Button {
                        model.request("action", ["actionId": model.spec.pagerPrev])
                    } label: {
                        Image(systemName: "chevron.backward")
                            .frame(width: 36, height: 36)
                            .nativeChip()
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Text(model.spec.pagerText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if !model.spec.pagerNext.isEmpty {
                    Button {
                        model.request("action", ["actionId": model.spec.pagerNext])
                    } label: {
                        Image(systemName: "chevron.forward")
                            .frame(width: 36, height: 36)
                            .nativeChip()
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 2)
        }
    }

    private func notice(_ text: String, tone: String, close: Bool) -> some View {
        NativeGlassCard(padding: 12) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(tone == "error" ? Color.red : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func badgeColor(_ tone: String) -> Color {
        switch tone {
        case "danger": return .red
        case "warning": return .orange
        case "success": return .green
        case "primary": return .accentColor
        default: return .secondary
        }
    }
}

// MARK: - 表单

private struct NativeInlineForm: View {
    let form: NativePageForm
    @ObservedObject var model: NativePageModel

    var body: some View {
        NativeGlassCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text(form.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if !form.message.isEmpty {
                    Text(form.message)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                ForEach(form.fields) { field in
                    NativeReadOnlyField(field: field)
                }
                Button {
                    model.form = form
                } label: {
                    Text(form.openTitle)
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 42)
                        .background(Color.accentColor, in: Capsule())
                        .foregroundStyle(Color.white)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// 内联卡片里的表单只显示当前值；点击后进入可编辑的 sheet。
private struct NativeReadOnlyField: View {
    let field: NativePageField

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(field.label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(display)
                .font(.caption)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.trailing)
                .lineLimit(3)
        }
    }

    private var display: String {
        switch field.kind {
        case "toggle": return field.value.bool ? "开" : "关"
        case "select":
            let id = field.value.text
            return field.options.first { $0.id == id }?.title ?? id
        case "multiselect":
            let selected = Set(field.value.list)
            return field.options.filter { selected.contains($0.id) }.map(\.title).joined(separator: "、")
        default: return field.value.text
        }
    }
}

struct NativeFormSheet: View {
    let form: NativePageForm
    @ObservedObject var model: NativePageModel
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: NativePageValue] = [:]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if !form.message.isEmpty {
                        Text(form.message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(form.fields) { field in
                        fieldView(field)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(NativeSheetBackground().ignoresSafeArea())
            .navigationTitle(form.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(form.cancelTitle) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(form.submitTitle) {
                        model.submit(form, values: collect())
                        dismiss()
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
    private func fieldView(_ field: NativePageField) -> some View {
        NativeGlassCard(padding: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text(field.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                switch field.kind {
                case "textarea":
                    TextField(field.placeholder, text: textBinding(field.id), axis: .vertical)
                        .lineLimit(4...12)
                        .nativeFieldBackground()
                case "select":
                    Picker("", selection: textBinding(field.id)) {
                        ForEach(field.options) { option in
                            Text(option.title).tag(option.id)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                case "multiselect":
                    NativeFlowLayout(spacing: 8, lineSpacing: 8) {
                        ForEach(field.options) { option in
                            let selected = values[field.id]?.list.contains(option.id) ?? false
                            Button {
                                var list = values[field.id]?.list ?? []
                                if let index = list.firstIndex(of: option.id) { list.remove(at: index) } else { list.append(option.id) }
                                values[field.id] = .list(list)
                            } label: {
                                Text(option.title)
                                    .font(.caption)
                                    .nativeChip(selected: selected, tint: .accentColor)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                case "toggle":
                    Toggle(field.label, isOn: boolBinding(field.id))
                        .labelsHidden()
                case "date":
                    DatePicker("", selection: dateBinding(field.id), displayedComponents: .date)
                        .labelsHidden()
                        .datePickerStyle(.compact)
                case "datetime":
                    DatePicker("", selection: dateBinding(field.id, includeTime: true), displayedComponents: [.date, .hourAndMinute])
                        .labelsHidden()
                        .datePickerStyle(.compact)
                case "number":
                    TextField(field.placeholder, text: textBinding(field.id))
                        .keyboardType(.decimalPad)
                        .nativeFieldBackground()
                case "image":
                    imageField(field)
                case "info":
                    Text(field.value.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                default:
                    TextField(field.placeholder, text: textBinding(field.id))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .nativeFieldBackground()
                }
                if !field.footer.isEmpty {
                    Text(field.footer)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder
    private func imageField(_ field: NativePageField) -> some View {
        HStack(spacing: 10) {
            if let image = imageFor(field.id) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else if let url = URL(string: values[field.id]?.text ?? ""), url.scheme == "https" {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Color.primary.opacity(0.06)
                }
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: 56, height: 56)
                    .overlay(Image(systemName: "photo").foregroundStyle(.tertiary))
            }
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
                Text("选择图片")
                    .font(.caption)
                    .nativeChip()
            }
            if !(values[field.id]?.text ?? "").isEmpty {
                Button {
                    values[field.id] = .text("")
                } label: {
                    Text("移除").font(.caption).foregroundStyle(.red)
                }
                .buttonStyle(.plain)
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
        NativeGlassCard(padding: 12) {
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
                        if !item.actions.isEmpty {
                            Button {
                                model.actionSheet = NativePageRow(
                                    id: item.id, title: item.caption, subtitle: "", detail: "",
                                    image: "", protectedImage: "", badge: "", badgeTone: "",
                                    chips: [], actions: item.actions, selected: false
                                )
                            } label: {
                                Image(systemName: "ellipsis.circle.fill")
                                    .font(.system(size: 20))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(Color.white, Color.black.opacity(0.5))
                                    .padding(6)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}

private struct NativeCalendarCard: View {
    let calendar: NativePageCalendar
    let action: (String) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    var body: some View {
        NativeGlassCard(padding: 14) {
            VStack(spacing: 10) {
                HStack {
                    Button {
                        if !calendar.previousAction.isEmpty { action(calendar.previousAction) }
                    } label: {
                        Image(systemName: "chevron.left").frame(width: 34, height: 34)
                    }
                    .buttonStyle(.plain)
                    Spacer()
                    Text(calendar.monthLabel).font(.subheadline.weight(.semibold))
                    Spacer()
                    Button {
                        if !calendar.nextAction.isEmpty { action(calendar.nextAction) }
                    } label: {
                        Image(systemName: "chevron.right").frame(width: 34, height: 34)
                    }
                    .buttonStyle(.plain)
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
                                    Text("\(day.day)").font(.caption)
                                    if day.count > 0 {
                                        Text("\(day.count)").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color.accentColor)
                                    } else if day.hasDraft {
                                        Circle().fill(Color.orange).frame(width: 4, height: 4)
                                    } else {
                                        Color.clear.frame(width: 4, height: 4)
                                    }
                                }
                                .frame(maxWidth: .infinity, minHeight: 42)
                                .background(day.selected ? Color.accentColor.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(day.selected ? Color.accentColor : Color.clear, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
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
