// 由 src/styles/tokens.json 生成（npm run tokens），不要手改。规格见 frontend/doc/DESIGN_SYSTEM.md
import SwiftUI
import UIKit

/// 设计令牌，与网页的 tokens.generated.css 同源：颜色随浅色 / 深色界面切换。
/// 主色 / 辅色以网页下发的住民设置为准，theme* 只是缺省值；字号用系统 Dynamic Type 样式，不在这里定义。
enum FM {
    /// UIKit 用的同一组颜色（UIView.backgroundColor 等）
    enum UI {
        static let bgBase = fmDynamicColor(0xF9F8FA, 1, 0x121016, 1)
        static let bgSurface = fmDynamicColor(0xFFFFFF, 1, 0x1A1625, 1)
        static let bgOverlay = fmDynamicColor(0xF2EEF5, 1, 0x251F34, 1)
        static let border = fmDynamicColor(0xE6DCEB, 1, 0x382E47, 1)
        static let textPrimary = fmDynamicColor(0x2B2533, 1, 0xF3EFEF, 1)
        static let textSecondary = fmDynamicColor(0x6E6578, 1, 0x9E97A9, 1)
        static let textMuted = fmDynamicColor(0x857C90, 1, 0x7D748A, 1)
        static let success = fmDynamicColor(0x3D9970, 1, 0x5CD698, 1)
        static let successText = fmDynamicColor(0x317A5A, 1, 0x5CD698, 1)
        static let warning = fmDynamicColor(0xE67E22, 1, 0xFFB049, 1)
        static let warningText = fmDynamicColor(0xA15818, 1, 0xFFB049, 1)
        static let danger = fmDynamicColor(0xD9534F, 1, 0xFF6B6B, 1)
        static let dangerText = fmDynamicColor(0xB64642, 1, 0xFF6B6B, 1)
        static let info = fmDynamicColor(0x3498DB, 1, 0x64B5F6, 1)
        static let infoText = fmDynamicColor(0x2670A2, 1, 0x64B5F6, 1)
        static let onEmphasis = fmDynamicColor(0x2B2533, 1, 0x2B2533, 1)
        static let backdrop = fmDynamicColor(0x121016, 0.32, 0x08060C, 0.68)
        static let scrim = fmDynamicColor(0x000000, 0.55, 0x000000, 0.55)
        static let onScrim = fmDynamicColor(0xFFFFFF, 1, 0xFFFFFF, 1)
        static let mediaBg = fmDynamicColor(0x1A1625, 1, 0x1A1625, 1)
        static let location = fmDynamicColor(0x1A73E8, 1, 0x1A73E8, 1)
        static let themePrimary = fmDynamicColor(0xE2789F, 1, 0xFF8FB1, 1)
        static let themePrimaryText = fmDynamicColor(0x9E546F, 1, 0xFF8FB1, 1)
        static let themeOnPrimary = fmDynamicColor(0x2B2533, 1, 0x2B2533, 1)
        static let themeSecondary = fmDynamicColor(0x8C6BB1, 1, 0xA882DD, 1)
    }

    static let bgBase = Color(uiColor: UI.bgBase)
    static let bgSurface = Color(uiColor: UI.bgSurface)
    static let bgOverlay = Color(uiColor: UI.bgOverlay)
    static let border = Color(uiColor: UI.border)
    static let textPrimary = Color(uiColor: UI.textPrimary)
    static let textSecondary = Color(uiColor: UI.textSecondary)
    static let textMuted = Color(uiColor: UI.textMuted)
    static let success = Color(uiColor: UI.success)
    static let successText = Color(uiColor: UI.successText)
    static let warning = Color(uiColor: UI.warning)
    static let warningText = Color(uiColor: UI.warningText)
    static let danger = Color(uiColor: UI.danger)
    static let dangerText = Color(uiColor: UI.dangerText)
    static let info = Color(uiColor: UI.info)
    static let infoText = Color(uiColor: UI.infoText)
    static let onEmphasis = Color(uiColor: UI.onEmphasis)
    static let backdrop = Color(uiColor: UI.backdrop)
    static let scrim = Color(uiColor: UI.scrim)
    static let onScrim = Color(uiColor: UI.onScrim)
    static let mediaBg = Color(uiColor: UI.mediaBg)
    static let location = Color(uiColor: UI.location)
    static let themePrimary = Color(uiColor: UI.themePrimary)
    static let themePrimaryText = Color(uiColor: UI.themePrimaryText)
    static let themeOnPrimary = Color(uiColor: UI.themeOnPrimary)
    static let themeSecondary = Color(uiColor: UI.themeSecondary)

    enum Radius {
        static let xs: CGFloat = 6
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 20
        static let xl: CGFloat = 28
        static let sheet: CGFloat = 40
        static let full: CGFloat = 999
    }

    enum Space {
        static let s1: CGFloat = 4
        static let s2: CGFloat = 8
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s5: CGFloat = 24
        static let s6: CGFloat = 32
        static let s4_5: CGFloat = 20
    }
}

private func fmDynamicColor(_ light: UInt32, _ lightAlpha: CGFloat, _ dark: UInt32, _ darkAlpha: CGFloat) -> UIColor {
    UIColor { traits in
        traits.userInterfaceStyle == .dark ? fmColor(dark, darkAlpha) : fmColor(light, lightAlpha)
    }
}

private func fmColor(_ value: UInt32, _ alpha: CGFloat) -> UIColor {
    UIColor(red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: alpha)
}
