import Capacitor
import SwiftUI
import UIKit
import WebKit

/// 聚餐由原生导航栈呈现，网络请求和登录凭证由网页会话处理。
@objc(NativeDinnerPlugin)
public class NativeDinnerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeDinnerPlugin"
    public let jsName = "NativeDinner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise)
    ]

    private let presenter = NativeContainedScreenPresenter()
    private var host: UIViewController?
    private var session: NativeDinnerSession?
    private var openCall: CAPPluginCall?
    private var sessionID: String?
    private var presenting = false
    private var closing = false
    private var queuedClose = false
    private var closeCalls: [CAPPluginCall] = []
    private var loadingObservation: NSKeyValueObservation?

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { DispatchQueue.main.async { self?.finish(animated: false) } }
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), !id.isEmpty else {
                call.reject("Missing session id", "INVALID_ARGUMENT"); return
            }
            guard self.host == nil, let parent = self.bridge?.viewController,
                  parent.viewIfLoaded?.window != nil, parent.presentedViewController == nil else {
                call.reject("Another screen is being presented", "BUSY"); return
            }
            let session = NativeDinnerSession(call: call) { [weak self] event in
                guard let self, self.sessionID == id else { return }
                var payload = event
                payload["id"] = id
                self.notifyListeners("dinnerEvent", data: payload)
            }
            session.onClose = { [weak self] result in self?.finish(result: result) }
            var path: [NativeDinnerRoute] = []
            if call.getBool("create", false) { path = [.create] }
            else if let dinnerID = call.getInt("dinnerId"), dinnerID > 0 { path = [.detail(dinnerID)] }
            let root = NativeDinnerRoot(session: session, initialPath: path) { [weak self] isRoot in
                self?.presenter.edgeEnabled = isRoot
            }
            let host = UIHostingController(rootView: root)
            host.overrideUserInterfaceStyle = session.dark ? .dark : .light
            host.view.backgroundColor = FM.UI.bgBase
            host.view.accessibilityViewIsModal = true
            self.host = host
            self.session = session
            self.openCall = call
            self.sessionID = id
            self.presenting = true
            self.presenter.edgeEnabled = path.isEmpty
            self.presenter.onEdgeBack = { [weak self] in
                guard let self, !self.presenting, !self.closing else { return false }
                self.finish()
                return true
            }
            self.presenter.present(host, from: parent) { [weak self] in
                guard let self else { return }
                self.presenting = false
                if self.queuedClose {
                    self.queuedClose = false
                    self.finish(animated: false)
                }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), self.sessionID == id else { call.resolve(); return }
            self.closeCalls.append(call)
            self.finish(animated: false)
        }
    }

    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), self.sessionID == id,
                  let requestID = call.getString("requestId") else { return }
            self.session?.respond(requestID, ok: call.getBool("ok", false),
                                  payload: call.getObject("payload") ?? [:], message: call.getString("message") ?? "")
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), self.sessionID == id, let theme = call.getObject("theme") else { return }
            self.session?.colors = NativeDinnerSession.themeColors(theme)
            if let dark = theme["dark"] as? Bool { self.host?.overrideUserInterfaceStyle = dark ? .dark : .light }
        }
    }

    @MainActor
    private func finish(result: [String: Any] = ["action": "back"], animated: Bool = true) {
        guard let host, !closing else { return }
        if presenting { queuedClose = true; return }
        closing = true
        session?.cancelAll()
        presenter.dismiss(host, animated: animated) { [weak self] in
            guard let self else { return }
            var response = result
            response["id"] = self.sessionID
            let call = self.openCall
            let closeCalls = self.closeCalls
            self.openCall = nil
            self.closeCalls.removeAll()
            self.host = nil
            self.session = nil
            self.sessionID = nil
            self.closing = false
            call?.resolve(response)
            closeCalls.forEach { $0.resolve() }
        }
    }
}

private struct NativeDinnerError: Error {
    let message: String
}

@MainActor
private final class NativeDinnerSession: ObservableObject {
    @Published var colors: NativeThemeColors
    let dark: Bool
    let canWrite: Bool
    var onClose: (([String: Any]) -> Void)?
    private let labels: [String: String]
    private let send: ([String: Any]) -> Void
    private var pending: [String: (timeout: DispatchWorkItem, continuation: CheckedContinuation<JSObject, Error>)] = [:]
    private var closed = false

    init(call: CAPPluginCall, send: @escaping ([String: Any]) -> Void) {
        let theme = call.getObject("theme") ?? [:]
        colors = Self.themeColors(theme)
        dark = theme["dark"] as? Bool ?? false
        canWrite = call.getBool("canWrite", false)
        labels = (call.getObject("labels") ?? [:]).compactMapValues { $0 as? String }
        self.send = send
    }

    static func themeColors(_ theme: JSObject) -> NativeThemeColors {
        NativeThemeColors(primary: theme["primary"] as? String, secondary: theme["secondary"] as? String,
                          onPrimary: theme["onPrimary"] as? String, primaryText: theme["primaryText"] as? String)
    }

    func text(_ key: String) -> String { labels[key] ?? "" }

    func close() { onClose?(["action": "back"]) }

    func login(create: Bool = false, dinnerID: Int? = nil) {
        var result: [String: Any] = ["action": "login", "create": create]
        if let dinnerID { result["dinnerId"] = dinnerID }
        onClose?(result)
    }

    func request(_ action: String, values: [String: Any] = [:]) async throws -> JSObject {
        guard !closed, !Task.isCancelled else { throw CancellationError() }
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            let timeout = DispatchWorkItem { [weak self] in self?.respond(id, ok: false, payload: [:], message: "") }
            pending[id] = (timeout, continuation)
            DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: timeout)
            send(["type": action, "requestId": id, "values": values])
        }
    }

    func respond(_ id: String, ok: Bool, payload: JSObject, message: String) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.timeout.cancel()
        if ok { request.continuation.resume(returning: payload) }
        else { request.continuation.resume(throwing: NativeDinnerError(message: message)) }
    }

    func cancelAll() {
        closed = true
        let requests = Array(pending.values)
        pending.removeAll()
        for request in requests {
            request.timeout.cancel()
            request.continuation.resume(throwing: CancellationError())
        }
    }

    func message(_ error: Error, fallback: String) -> String {
        if let message = (error as? NativeDinnerError)?.message, !message.isEmpty { return message }
        return text(fallback)
    }
}

private func nativeDinnerDate(_ value: Any?) -> Date? {
    guard let millis = (value as? NSNumber)?.doubleValue, millis.isFinite else { return nil }
    return Date(timeIntervalSince1970: millis / 1000)
}

private func nativeDinnerISO(_ date: Date?) -> Any {
    guard let date else { return NSNull() }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

private struct NativeDinnerProposal {
    let places: [String]
    let times: [Date]

    init(_ value: JSObject) {
        places = value["places"] as? [String] ?? []
        times = (value["times"] as? [NSNumber] ?? []).compactMap { nativeDinnerDate($0) }
    }
}

private struct NativeDinner: Identifiable {
    let id: Int
    let title: String
    let description: String
    let place: String
    let start: Date?
    let timeLabel: String
    let placeLabel: String
    let status: String
    let contact: String
    let participants: String
    let isEnded: Bool
    let isOrganizer: Bool
    let isJoined: Bool
    let isFull: Bool
    let canDelete: Bool
    let myProposal: NativeDinnerProposal?
    let proposals: [NativeDinnerProposal]
    let shareURL: URL?

    init?(_ value: JSObject) {
        guard let id = value["id"] as? Int, let title = value["title"] as? String else { return nil }
        self.id = id
        self.title = title
        description = value["description"] as? String ?? ""
        place = value["place"] as? String ?? ""
        start = nativeDinnerDate(value["start"])
        timeLabel = value["timeLabel"] as? String ?? ""
        placeLabel = value["placeLabel"] as? String ?? ""
        status = value["status"] as? String ?? ""
        contact = value["contact"] as? String ?? ""
        participants = value["participants"] as? String ?? ""
        isEnded = value["isEnded"] as? Bool ?? false
        isOrganizer = value["isOrganizer"] as? Bool ?? false
        isJoined = value["isJoined"] as? Bool ?? false
        isFull = value["isFull"] as? Bool ?? false
        canDelete = value["canDelete"] as? Bool ?? false
        myProposal = (value["myProposal"] as? JSObject).map(NativeDinnerProposal.init)
        proposals = (value["proposals"] as? [JSObject] ?? []).map(NativeDinnerProposal.init)
        shareURL = (value["shareUrl"] as? String).flatMap { URL(string: $0) }
    }
}

private enum NativeDinnerRoute: Hashable {
    case create
    case detail(Int)
}

private struct NativeDinnerRoot: View {
    @ObservedObject var session: NativeDinnerSession
    let onAtRoot: (Bool) -> Void
    @State private var path: [NativeDinnerRoute]
    @State private var revision = 0

    init(session: NativeDinnerSession, initialPath: [NativeDinnerRoute], onAtRoot: @escaping (Bool) -> Void) {
        self.session = session
        self.onAtRoot = onAtRoot
        _path = State(initialValue: initialPath)
    }

    var body: some View {
        NavigationStack(path: $path) {
            NativeDinnerList(session: session, revision: revision, onCreate: {
                if session.canWrite { path.append(.create) }
                else { session.login(create: true) }
            }, onDetail: { path.append(.detail($0)) })
            .navigationTitle(session.text("title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: session.close) {
                        Image(systemName: "chevron.backward").font(.headline)
                    }
                    .tint(session.colors.primaryText)
                    .accessibilityLabel(session.text("back"))
                }
            }
            .navigationDestination(for: NativeDinnerRoute.self) { route in
                switch route {
                case .create:
                    NativeDinnerCreate(session: session) { id in
                        if path.last == .create { path = [.detail(id)] }
                    }
                case .detail(let id):
                    NativeDinnerDetail(session: session, id: id) {
                        if path.last == .detail(id) { path.removeAll() }
                    }
                }
            }
        }
        .nativeThemeColors(session.colors)
        .onChange(of: path) { _, current in
            onAtRoot(current.isEmpty)
            if current.isEmpty { revision += 1 }
        }
    }
}

private struct NativeDinnerSummary: View {
    let dinner: NativeDinner

    var body: some View {
        VStack(alignment: .leading, spacing: FM.Space.s1) {
            Text([dinner.start?.formatted(date: .abbreviated, time: .shortened) ?? dinner.timeLabel, dinner.placeLabel].joined(separator: " · "))
                .font(.subheadline)
            Text(dinner.status).font(.footnote)
        }
        .foregroundStyle(.secondary)
    }
}

private struct NativeDinnerList: View {
    let session: NativeDinnerSession
    let revision: Int
    let onCreate: () -> Void
    let onDetail: (Int) -> Void
    @State private var query = ""
    @State private var includeEnded = false
    @State private var items: [NativeDinner] = []
    @State private var nextOffset = 0
    @State private var offset = 0
    @State private var error = ""
    @State private var loading = true
    @State private var hasMore = false
    @State private var retry = 0
    @State private var debounceQuery = false
    @FocusState private var searchFocused: Bool

    private struct Request: Equatable {
        let query: String
        let includeEnded: Bool
        let revision: Int
        let offset: Int
        let retry: Int
        let debounceQuery: Bool
    }

    var body: some View {
        let request = Request(query: query, includeEnded: includeEnded, revision: revision,
                              offset: offset, retry: retry, debounceQuery: debounceQuery)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: FM.Space.s3) {
                HStack(spacing: FM.Space.s2) {
                    Button(session.text("create"), action: onCreate)
                        .modifier(NativeDinnerPrimaryButton())
                    Spacer(minLength: 0)
                    HStack(spacing: FM.Space.s2) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                        TextField(session.text("search"), text: Binding(get: { query }, set: { text in
                            query = text
                            offset = 0
                            debounceQuery = true
                        }))
                            .focused($searchFocused)
                            .submitLabel(.search)
                            .onSubmit(submitSearch)
                    }
                    .padding(.horizontal, FM.Space.s3)
                    .frame(minHeight: 44)
                    .background(FM.bgSurface, in: Capsule())
                    .overlay { Capsule().strokeBorder(FM.border) }
                    .frame(maxWidth: 320)
                    Button(action: submitSearch) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundStyle(session.colors.onPrimary)
                            .frame(width: 44, height: 44)
                            .background(session.colors.primary, in: Circle())
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(session.text("submitSearch"))
                }
                HStack(spacing: FM.Space.s2) {
                    Spacer(minLength: 0)
                    Text(session.text("showEnded")).accessibilityHidden(true)
                    Toggle(session.text("showEnded"), isOn: Binding(get: { includeEnded }, set: { enabled in
                        includeEnded = enabled
                        offset = 0
                        debounceQuery = false
                    }))
                    .labelsHidden()
                    .fixedSize()
                }
                .frame(minHeight: 44)
                ForEach(items) { dinner in
                    VStack(alignment: .leading, spacing: FM.Space.s2) {
                        HStack {
                            Text(dinner.title).font(.headline)
                            Spacer(minLength: FM.Space.s2)
                            Button(session.text("viewDetail")) { onDetail(dinner.id) }
                                .buttonStyle(.bordered)
                                .controlSize(.large)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        NativeDinnerSummary(dinner: dinner)
                        if !dinner.description.isEmpty { Text(dinner.description).font(.subheadline) }
                    }
                    .padding(FM.Space.s4)
                    .background(FM.bgSurface, in: RoundedRectangle(cornerRadius: FM.Radius.lg, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: FM.Radius.lg, style: .continuous).strokeBorder(FM.border) }
                }
                if loading { ProgressView(session.text("loading")) }
                else if !error.isEmpty {
                    Text(error).foregroundStyle(FM.dangerText)
                    Button(session.text("retry")) { retry += 1 }.buttonStyle(.bordered)
                } else if items.isEmpty {
                    Text(session.text(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "empty" : "noResults"))
                        .foregroundStyle(.secondary)
                } else if hasMore {
                    Button(session.text("more")) { offset = nextOffset }.buttonStyle(.bordered)
                }
            }
            .padding(FM.Space.s4)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .nativePageBackground()
        .onChange(of: revision) { _, _ in offset = 0 }
        .task(id: request) { await load(request) }
    }

    private func submitSearch() {
        searchFocused = false
        offset = 0
        debounceQuery = false
        retry += 1
    }

    private func load(_ request: Request) async {
        guard !Task.isCancelled else { return }
        if request.offset == 0 { items = []; hasMore = false }
        loading = true
        error = ""
        do {
            if request.offset == 0 && !request.query.isEmpty && request.debounceQuery {
                try await Task.sleep(for: .milliseconds(250))
            }
            let payload = try await session.request("list", values: ["query": request.query, "includeEnded": request.includeEnded, "offset": request.offset])
            guard !Task.isCancelled else { return }
            let page = (payload["items"] as? [JSObject] ?? []).compactMap(NativeDinner.init)
            let seen = Set(items.map(\.id))
            items += page.filter { !seen.contains($0.id) }
            nextOffset = payload["nextOffset"] as? Int ?? items.count
            hasMore = payload["hasMore"] as? Bool ?? false
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            self.error = session.message(error, fallback: "loadError")
        }
        loading = false
    }
}

private struct NativeDinnerPrimaryButton: ViewModifier {
    @Environment(\.nativeOnPrimary) private var onPrimary

    func body(content: Content) -> some View {
        content.buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
            .controlSize(.large).foregroundStyle(onPrimary)
    }
}

private struct NativeDinnerDateField: View {
    let title: String
    @Binding var date: Date?

    var body: some View {
        Toggle(title, isOn: Binding(get: { date != nil }, set: { enabled in
            if enabled { date = Date().addingTimeInterval(1800) }
            else { date = nil }
        }))
        if let date {
            DatePicker(title, selection: Binding(get: { self.date ?? date }, set: { self.date = $0 }))
                .datePickerStyle(.compact)
        }
    }
}

private struct NativeDinnerCreate: View {
    let session: NativeDinnerSession
    let onCreated: (Int) -> Void
    @State private var title = ""
    @State private var description = ""
    @State private var place = ""
    @State private var start: Date?
    @State private var max = ""
    @State private var contact = ""
    @State private var busy = false
    @State private var error = ""
    @State private var visible = false

    var body: some View {
        Form {
            Section {
                TextField(session.text("titleField"), text: $title)
                TextField(session.text("placeField"), text: $place)
                NativeDinnerDateField(title: session.text("timeField"), date: $start)
            }.listRowBackground(FM.bgSurface)
            Section {
                TextField(session.text("max"), text: $max).keyboardType(.numberPad)
                TextField(session.text("contact"), text: $contact)
                TextField(session.text("description"), text: $description, axis: .vertical).lineLimit(3...8)
            }.listRowBackground(FM.bgSurface)
            Section {
                Button(session.text(busy ? "saving" : "submit")) {
                    if session.canWrite { Task { await submit() } }
                    else { session.login(create: true) }
                }
                .modifier(NativeDinnerPrimaryButton())
                .disabled(busy || (session.canWrite && title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                if !error.isEmpty { Text(error).foregroundStyle(FM.dangerText) }
            }.listRowBackground(FM.bgSurface)
        }
        .nativePageBackground()
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(session.text("create"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }

    private func submit() async {
        guard !busy else { return }
        busy = true
        error = ""
        defer { busy = false }
        do {
            let payload = try await session.request("create", values: ["title": title, "description": description,
                "place": place, "start": nativeDinnerISO(start), "max": max, "contact": contact])
            guard let item = payload["item"] as? JSObject, let id = item["id"] as? Int else {
                throw NativeDinnerError(message: "")
            }
            if visible { onCreated(id) }
        } catch {
            if !(error is CancellationError) { self.error = session.message(error, fallback: "actionError") }
        }
    }
}

private struct NativeDinnerDetail: View {
    let session: NativeDinnerSession
    let id: Int
    let onDelete: () -> Void
    @State private var item: NativeDinner?
    @State private var loadError = ""
    @State private var actionError = ""
    @State private var saved = ""
    @State private var revision = 0
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var confirmLeave = false
    @State private var visible = false
    @State private var schedulePlace = ""
    @State private var scheduleTime: Date?
    @State private var places = Array(repeating: "", count: 3)
    @State private var times = Array<Date?>(repeating: nil, count: 3)

    var body: some View {
        Form {
            if let item {
                summary(item)
                if !item.isEnded && item.isOrganizer { schedule(item) }
                if !item.isEnded && !item.isOrganizer && item.isJoined { proposal }
                if !saved.isEmpty { Text(saved).foregroundStyle(FM.successText).listRowBackground(FM.bgSurface) }
                Section {
                    if let url = item.shareURL { ShareLink(item: url) { Text(session.text("share")) } }
                    if item.canDelete {
                        Button(session.text("delete"), role: .destructive) { confirmDelete = true }.disabled(busy)
                    }
                }.listRowBackground(FM.bgSurface)
            } else if !loadError.isEmpty {
                Text(loadError).foregroundStyle(FM.dangerText).listRowBackground(FM.bgSurface)
                Button(session.text("retry")) { revision += 1 }.listRowBackground(FM.bgSurface)
            } else { ProgressView(session.text("loading")).listRowBackground(FM.bgSurface) }
        }
        .nativePageBackground()
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(session.text("detail"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: revision) { await load() }
        .alert(session.text("confirmDelete"), isPresented: $confirmDelete) {
            Button(session.text("delete"), role: .destructive) { Task { await change("delete") } }
            Button(session.text("cancel"), role: .cancel) {}
        }
        .alert(session.text("confirmLeave"), isPresented: $confirmLeave) {
            Button(session.text("leave"), role: .destructive) { Task { await change("leave") } }
            Button(session.text("cancel"), role: .cancel) {}
        }
        .alert(actionError, isPresented: Binding(get: { !actionError.isEmpty }, set: { if !$0 { actionError = "" } })) {
            Button(session.text("back"), role: .cancel) { actionError = "" }
        }
    }

    private func summary(_ dinner: NativeDinner) -> some View {
        Section {
            VStack(alignment: .leading, spacing: FM.Space.s2) {
                Text(dinner.title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
                NativeDinnerSummary(dinner: dinner)
                if !dinner.description.isEmpty { Text(dinner.description) }
                Text(dinner.participants).foregroundStyle(.secondary)
                if !dinner.contact.isEmpty {
                    LabeledContent(session.text("contactLabel"), value: dinner.contact).font(.subheadline)
                }
            }
            if !dinner.isEnded && !dinner.isOrganizer {
                if dinner.isJoined {
                    Button(session.text("leave")) { confirmLeave = true }.disabled(busy)
                } else if dinner.isFull {
                    Text(session.text("full")).foregroundStyle(.secondary)
                } else {
                    Button(session.text("join")) {
                        if session.canWrite { Task { await change("join") } }
                        else { session.login(dinnerID: id) }
                    }.modifier(NativeDinnerPrimaryButton()).disabled(busy)
                }
            }
        }.listRowBackground(FM.bgSurface)
    }

    @ViewBuilder
    private func schedule(_ dinner: NativeDinner) -> some View {
        let suggestedPlaces = Set(dinner.proposals.flatMap(\.places)).sorted()
        let suggestedTimes = Set(dinner.proposals.flatMap(\.times)).sorted()
        Section(session.text("schedule")) {
            TextField(session.text("schedulePlace"), text: $schedulePlace)
            NativeDinnerDateField(title: session.text("scheduleTime"), date: $scheduleTime)
            Button(session.text(busy ? "saving" : "saveSchedule")) {
                Task { await change("schedule", values: ["place": schedulePlace, "start": nativeDinnerISO(scheduleTime)], success: "scheduleSaved") }
            }.modifier(NativeDinnerPrimaryButton()).disabled(busy)
        }.listRowBackground(FM.bgSurface)
        if !suggestedPlaces.isEmpty || !suggestedTimes.isEmpty {
            if !suggestedPlaces.isEmpty {
                Section(session.text("places")) {
                    ForEach(suggestedPlaces, id: \.self) { place in
                        Button(place) { schedulePlace = place }.disabled(busy)
                    }
                }.listRowBackground(FM.bgSurface)
            }
            if !suggestedTimes.isEmpty {
                Section(session.text("times")) {
                    ForEach(suggestedTimes, id: \.self) { date in
                        Button(date.formatted(date: .abbreviated, time: .shortened)) { scheduleTime = date }.disabled(busy)
                    }
                }.listRowBackground(FM.bgSurface)
            }
        } else {
            Section(session.text("suggestions")) {
                Text(session.text("noSuggestions")).foregroundStyle(.secondary)
            }.listRowBackground(FM.bgSurface)
        }
    }

    private var proposal: some View {
        Section(session.text("proposal")) {
            Text(session.text("proposalHint")).font(.footnote).foregroundStyle(.secondary)
            ForEach(places.indices, id: \.self) { index in
                TextField(session.text("proposalPlace\(index + 1)"), text: $places[index])
            }
            ForEach(times.indices, id: \.self) { index in
                NativeDinnerDateField(title: session.text("proposalTime\(index + 1)"), date: $times[index])
            }
            Button(session.text(busy ? "saving" : "saveProposal")) {
                let filledPlaces = places.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                Task { await change("proposal", values: ["places": filledPlaces, "times": times.compactMap { $0 }.map { nativeDinnerISO($0) }], success: "proposalSaved") }
            }.modifier(NativeDinnerPrimaryButton()).disabled(busy)
        }.listRowBackground(FM.bgSurface)
    }

    private func apply(_ payload: JSObject) throws {
        guard let value = payload["item"] as? JSObject, let dinner = NativeDinner(value) else {
            throw NativeDinnerError(message: "")
        }
        item = dinner
        schedulePlace = dinner.place
        scheduleTime = dinner.start
        let suggestedPlaces = dinner.myProposal?.places ?? []
        let suggestedTimes = dinner.myProposal?.times ?? []
        places = (0..<3).map { $0 < suggestedPlaces.count ? suggestedPlaces[$0] : "" }
        times = (0..<3).map { $0 < suggestedTimes.count ? suggestedTimes[$0] : nil }
    }

    private func load() async {
        loadError = ""
        do {
            let payload = try await session.request("detail", values: ["dinnerId": id])
            if !Task.isCancelled { try apply(payload) }
        } catch {
            if !Task.isCancelled && !(error is CancellationError) { loadError = session.message(error, fallback: "loadError") }
        }
    }

    private func change(_ action: String, values: [String: Any] = [:], success: String? = nil) async {
        guard !busy else { return }
        busy = true
        saved = ""
        defer { busy = false }
        var input = values
        input["dinnerId"] = id
        do {
            let payload = try await session.request(action, values: input)
            guard visible else { return }
            if action == "delete" { onDelete() }
            else { try apply(payload) }
            if let success { saved = session.text(success) }
        } catch {
            if !(error is CancellationError) { actionError = session.message(error, fallback: "actionError") }
        }
    }
}
