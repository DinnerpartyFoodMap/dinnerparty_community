#!/usr/bin/env node
// 为 Capacitor 生成的原生工程补充本项目需要的配置。可重复执行（已存在的内容会跳过）。
//   node scripts/patch-native-projects.mjs            # 处理已存在的 android/ 与 ios/
//   node scripts/patch-native-projects.mjs android    # 只处理 Android
//   node scripts/patch-native-projects.mjs ios        # 只处理 iOS
//
// Android：定位权限与高德定位 SDK（依赖、Key、插件注册）、外部链接/地图应用可见性（<queries>）、Android 11/12 照片选择器回补
// iOS：相机/相册/定位用途说明、只支持 iPhone 竖屏与 arm64、开发区域简体中文、出口合规声明、隐私清单（PrivacyInfo.xcprivacy）、通用链接（App.entitlements）、SPM 版本兼容

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
const changes = [];

function patchFile(path, label, transform) {
    const before = readFileSync(path, 'utf8');
    const after = transform(before);
    if (after !== before) {
        writeFileSync(path, after);
        changes.push(label);
    }
}

function insertBefore(text, anchor, block, marker) {
    if (text.includes(marker)) return text;
    const index = text.lastIndexOf(anchor);
    if (index < 0) throw new Error(`找不到插入位置：${anchor}`);
    return text.slice(0, index) + block + text.slice(index);
}

// 与 android/app/build.gradle 中的版本一致
const AMAP_LOCATION_VERSION = '11.3.000';
const ANDROID_LOCATION_PERMISSIONS = ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_STATE'];

function patchAndroid() {
    const manifest = resolve(root, 'android/app/src/main/AndroidManifest.xml');
    if (!existsSync(manifest)) {
        console.log('跳过 Android：尚未生成 android/ 工程（npm run cap:add:android）');
        return;
    }
    // 旧工程已有部分权限时只补缺少的，避免重复声明
    patchFile(manifest, 'Android 定位权限', (text) => {
        const missing = ANDROID_LOCATION_PERMISSIONS.filter((name) => !text.includes(`"android.permission.${name}"`));
        if (!missing.length) return text;
        const lines = missing.map((name) => `    <uses-permission android:name="android.permission.${name}" />\n`).join('');
        const index = text.lastIndexOf('</manifest>');
        return `${text.slice(0, index)}
    <!-- 定位（Android 为高德定位 SDK）；网络与 WiFi 状态用于网络定位，不申请后台定位 -->
${lines}${text.slice(index)}`;
    });
    patchFile(manifest, 'Android 高德定位 SDK 配置', (text) => insertBefore(text, '</application>', `
        <!-- 高德定位 SDK：Key 由 app/build.gradle 注入（AMAP_ANDROID_KEY），绑定包名与签名 SHA1 -->
        <meta-data android:name="com.amap.api.v2.apikey" android:value="\${AMAP_ANDROID_KEY}" />
        <service android:name="com.amap.api.location.APSService" android:exported="false" />
`, 'com.amap.api.location.APSService'));
    patchFile(manifest, 'Android 外部链接可见性', (text) => insertBefore(text, '</manifest>', `
    <!-- Android 11+ 软件包可见性：允许查询能打开网页/地图链接的应用（导航、备案链接等） -->
    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="geo" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="androidamap" />
        </intent>
    </queries>
`, '<queries>'));
    patchFile(manifest, 'Android 照片选择器回补', (text) => insertBefore(text, '</application>', `
        <!-- @capacitor/camera：为 Android 11/12 自动安装回补的系统照片选择器 -->
        <service android:name="com.google.android.gms.metadata.ModuleDependencies"
            android:enabled="false"
            android:exported="false"
            tools:ignore="MissingClass">
            <intent-filter>
                <action android:name="com.google.android.gms.metadata.MODULE_DEPENDENCIES" />
            </intent-filter>
            <meta-data android:name="photopicker_activity:0:required" android:value="" />
        </service>
`, 'com.google.android.gms.metadata.ModuleDependencies'));
    patchFile(manifest, 'Android tools 命名空间', (text) => {
        if (text.includes('xmlns:tools=')) return text;
        return text.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android"', '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"');
    });
}

function patchAndroidGradle() {
    const gradle = resolve(root, 'android/app/build.gradle');
    if (!existsSync(gradle)) return;
    // 版本号：versionName 取 frontend/package.json 的 version；versionCode 取 CI 传入的 APP_BUILD_NUMBER（必须递增）
    patchFile(gradle, 'Android 版本号来源', (text) => {
        if (text.includes('APP_BUILD_NUMBER')) return text;
        return text
            .replace(/versionCode \d+/, 'versionCode((System.getenv("APP_BUILD_NUMBER") ?: "1").toInteger())')
            .replace(/versionName "[^"]*"/, 'versionName(new groovy.json.JsonSlurper().parse(file("../../package.json")).version)');
    });
    // 发布签名：仅在提供 ANDROID_KEYSTORE_PATH 等环境变量时启用（证书与密码放在 CI Secrets，不进仓库）
    patchFile(gradle, 'Android 发布签名配置', (text) => {
        if (text.includes('ANDROID_KEYSTORE_PATH')) return text;
        const signing = `    signingConfigs {
        release {
            if (System.getenv("ANDROID_KEYSTORE_PATH")) {
                storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            if (System.getenv("ANDROID_KEYSTORE_PATH")) {
                signingConfig signingConfigs.release
            }`;
        if (!/    buildTypes \{\n        release \{/.test(text)) throw new Error('android/app/build.gradle 结构与预期不同，请手动配置发布签名');
        return text.replace(/    buildTypes \{\n        release \{/, signing);
    });
    // 高德定位 SDK：依赖与 Key（AMAP_ANDROID_KEY 注入 Manifest 占位符），发布包缺 Key 时中止
    patchFile(gradle, 'Android 高德定位 SDK 依赖与 Key', (text) => {
        if (text.includes('AMAP_ANDROID_KEY')) return text;
        const anchors = {
            plugin: /apply plugin: 'com\.android\.application'\n/,
            defaultConfig: /( *)testInstrumentationRunner [^\n]*\n/,
            dependency: /( *)implementation project\(':capacitor-android'\)\n/,
            capacitor: /apply from: 'capacitor\.build\.gradle'\n/
        };
        for (const [name, pattern] of Object.entries(anchors)) {
            if (!pattern.test(text)) throw new Error(`android/app/build.gradle 结构与预期不同，请手动配置高德定位 SDK（缺少锚点 ${name}）`);
        }
        return text
            .replace(anchors.plugin, (line) => `${line}
// 高德 Android 平台 Key（定位 SDK），与包名和签名 SHA1 绑定：环境变量 / -P 参数 / android/local.properties 的 amap.android.key
def amapAndroidKey = System.getenv("AMAP_ANDROID_KEY") ?: (project.findProperty("AMAP_ANDROID_KEY") ?: {
    def local = rootProject.file("local.properties")
    if (!local.exists()) return ""
    def props = new Properties()
    local.withInputStream { props.load(it) }
    return props.getProperty("amap.android.key", "")
}())
`)
            .replace(anchors.defaultConfig, (line, indent) => `${line}${indent}manifestPlaceholders = [AMAP_ANDROID_KEY: amapAndroidKey]\n`)
            .replace(anchors.dependency, (line, indent) => `${line}${indent}implementation "com.amap.api:location:${AMAP_LOCATION_VERSION}"\n`)
            .replace(anchors.capacitor, (line) => `${line}
// 缺少 Key 时定位会报 KEY 鉴权失败：调试包只提示，发布包直接中止
if (!amapAndroidKey) {
    logger.warn("未配置 AMAP_ANDROID_KEY，App 定位将不可用")
    tasks.matching { it.name == 'preReleaseBuild' }.configureEach {
        doFirst { throw new GradleException("发布包需要高德 Android Key：设置环境变量 AMAP_ANDROID_KEY 或 local.properties 的 amap.android.key") }
    }
}
`);
    });
    const proguard = resolve(root, 'android/app/proguard-rules.pro');
    if (existsSync(proguard)) {
        patchFile(proguard, 'Android 高德定位混淆规则', (text) => text.includes('com.amap.api.location') ? text : `${text.trimEnd()}

# 高德定位 SDK（当前未开启混淆；开启 minifyEnabled 时需保留）
-keep class com.amap.api.location.** { *; }
-keep class com.amap.api.fence.** { *; }
-keep class com.loc.** { *; }
-keep class com.autonavi.aps.amapapi.model.** { *; }
-dontwarn com.amap.api.**
-dontwarn com.loc.**
`);
    }
}

// Android 应用内插件：源码直接维护在 android/app/src/main/java/cc/dinnerparty/foodmap/，这里只校验存在并在 MainActivity 注册
function patchAndroidPlugins() {
    const sourceDir = resolve(root, 'android/app/src/main/java/cc/dinnerparty/foodmap');
    const mainActivity = resolve(sourceDir, 'MainActivity.java');
    if (!existsSync(mainActivity)) return;
    if (!existsSync(resolve(sourceDir, 'AMapLocationPlugin.java'))) {
        throw new Error('缺少高德定位插件源码 AMapLocationPlugin.java（应位于 android/app/src/main/java/cc/dinnerparty/foodmap/）');
    }
    patchFile(mainActivity, 'Android 注册高德定位插件', (text) => {
        if (text.includes('AMapLocationPlugin')) return text;
        if (!/public class MainActivity extends BridgeActivity \{\s*\}/.test(text)) {
            throw new Error('MainActivity.java 结构与预期不同，请在 super.onCreate 前手动 registerPlugin(AMapLocationPlugin.class)');
        }
        return `package cc.dinnerparty.foodmap;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用内插件需在桥接创建前注册
        registerPlugin(AMapLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
    });
}

const IOS_PLIST_ENTRIES = [
    ['NSCameraUsageDescription', '用于拍摄地点、菜单、行程和反馈照片并上传。'],
    ['NSPhotoLibraryUsageDescription', '用于从相册选择地点、头像、行程和反馈图片。'],
    ['NSPhotoLibraryAddUsageDescription', '用于把海报和行程首图保存到相册。'],
    ['NSLocationWhenInUseUsageDescription', '用于在地图上显示你的位置并查找附近的饭店。'],
    ['NSLocationAlwaysAndWhenInUseUsageDescription', '本应用只在使用期间获取位置，用于在地图上显示你的位置。']
];

function patchIosSwiftPackage() {
    const manifest = resolve(root, 'ios/App/CapApp-SPM/Package.swift');
    if (!existsSync(manifest)) return;
    // cap sync 会重新生成 Swift tools 5.9 清单，但 .v18 枚举需要 PackageDescription 6.0。
    // 使用字符串版本保留部署目标，避免升级 Swift 语言模式；每次同步后都需修补。
    patchFile(manifest, 'iOS SPM 平台版本兼容', (text) => text.replace(
        /\.iOS\(\.v(\d+(?:_\d+)*)\)/g,
        (_, version) => `.iOS("${version.includes('_') ? version.replaceAll('_', '.') : `${version}.0`}")`
    ));
}

function patchIos() {
    const plist = resolve(root, 'ios/App/App/Info.plist');
    if (!existsSync(plist)) {
        console.log('跳过 iOS：尚未生成 ios/ 工程（需在 macOS 上执行 npm run cap:add:ios，或由 CI 生成）');
        return;
    }
    patchFile(plist, 'iOS 权限用途说明', (text) => {
        let block = '';
        for (const [key, value] of IOS_PLIST_ENTRIES) {
            if (!text.includes(`<key>${key}</key>`)) block += `\t<key>${key}</key>\n\t<string>${value}</string>\n`;
        }
        if (!text.includes('<key>ITSAppUsesNonExemptEncryption</key>')) {
            // 仅使用系统 HTTPS，无自定义加密：免去每次上传 TestFlight 时的出口合规问询
            block += '\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n';
        }
        if (!block) return text;
        const index = text.lastIndexOf('</dict>');
        return text.slice(0, index) + block + text.slice(index);
    });

    // Capacitor 模板默认 iPhone + iPad、横竖屏、armv7、开发区域 en；本项目只做了 iPhone 竖屏，界面是简体中文
    patchFile(plist, 'iOS 设备、方向与开发区域', (text) => {
        const nl = text.includes('\r\n') ? '\r\n' : '\n';
        const array = (...items) => `<array>${items.map((item) => `${nl}\t\t<string>${item}</string>`).join('')}${nl}\t</array>`;
        return text
            .replace(/(<key>CFBundleDevelopmentRegion<\/key>\s*<string>)[^<]*(<\/string>)/, '$1zh-Hans$2')
            .replace(/(<key>UIRequiredDeviceCapabilities<\/key>\s*)<array>[\s\S]*?<\/array>/, `$1${array('arm64')}`)
            .replace(/(<key>UISupportedInterfaceOrientations<\/key>\s*)<array>[\s\S]*?<\/array>/, `$1${array('UIInterfaceOrientationPortrait')}`)
            .replace(/\s*<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>[\s\S]*?<\/array>/, '');
    });

    const privacyTarget = resolve(root, 'ios/App/App/PrivacyInfo.xcprivacy');
    if (!existsSync(privacyTarget)) {
        copyFileSync(resolve(root, 'native/ios/PrivacyInfo.xcprivacy'), privacyTarget);
        changes.push('iOS 隐私清单文件');
    }
    const pbxproj = resolve(root, 'ios/App/App.xcodeproj/project.pbxproj');
    patchFile(pbxproj, 'iOS 只面向 iPhone、开发区域简体中文', (text) => text
        .replace(/TARGETED_DEVICE_FAMILY = "1,2";/g, 'TARGETED_DEVICE_FAMILY = 1;')
        .replace(/developmentRegion = en;/, 'developmentRegion = "zh-Hans";')
        .replace(/(knownRegions = \(\s*)en,/, '$1"zh-Hans",'));
    patchFile(pbxproj, 'iOS 隐私清单加入工程', (text) => {
        if (text.includes('PrivacyInfo.xcprivacy')) return text;
        const buildFileId = 'A7F1C0DE0000000000000001';
        const fileRefId = 'A7F1C0DE0000000000000002';
        const anchors = {
            buildFile: /(\t\t\S+ \/\* public in Resources \*\/ = \{isa = PBXBuildFile;[^\n]*\n)/,
            fileRef: /(\t\t\S+ \/\* Info\.plist \*\/ = \{isa = PBXFileReference;[^\n]*\n)/,
            groupChild: /(\t\t\t\t\S+ \/\* Info\.plist \*\/,\n)/,
            resource: /(\t\t\t\t\S+ \/\* public in Resources \*\/,\n)/
        };
        for (const [name, pattern] of Object.entries(anchors)) {
            if (!pattern.test(text)) throw new Error(`Xcode 工程结构与预期不同，请在 Xcode 中手动添加 PrivacyInfo.xcprivacy（缺少锚点 ${name}）`);
        }
        return text
            .replace(anchors.buildFile, `$1\t\t${buildFileId} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* PrivacyInfo.xcprivacy */; };\n`)
            .replace(anchors.fileRef, `$1\t\t${fileRefId} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n`)
            .replace(anchors.groupChild, `$1\t\t\t\t${fileRefId} /* PrivacyInfo.xcprivacy */,\n`)
            .replace(anchors.resource, `$1\t\t\t\t${buildFileId} /* PrivacyInfo.xcprivacy in Resources */,\n`);
    });

    // 通用链接：点击 https://www.dinnerparty.cc/... 直接打开 App（网站侧见 public/.well-known/apple-app-site-association）
    const entitlementsTarget = resolve(root, 'ios/App/App/App.entitlements');
    if (!existsSync(entitlementsTarget)) {
        copyFileSync(resolve(root, 'native/ios/App.entitlements'), entitlementsTarget);
        changes.push('iOS 通用链接 entitlements 文件');
    }
    patchFile(pbxproj, 'iOS 通用链接 entitlements 加入工程', (text) => {
        let next = text;
        if (!next.includes('/* App.entitlements */ = {isa = PBXFileReference;')) {
            const fileRefId = 'A7F1C0DE0000000000000003';
            const anchors = {
                fileRef: /(\t\t\S+ \/\* Info\.plist \*\/ = \{isa = PBXFileReference;[^\n]*\n)/,
                groupChild: /(\t\t\t\t\S+ \/\* Info\.plist \*\/,\n)/
            };
            for (const [name, pattern] of Object.entries(anchors)) {
                if (!pattern.test(next)) throw new Error(`Xcode 工程结构与预期不同，请在 Xcode 中手动添加 App.entitlements（缺少锚点 ${name}）`);
            }
            next = next
                .replace(anchors.fileRef, `$1\t\t${fileRefId} /* App.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = "<group>"; };\n`)
                .replace(anchors.groupChild, `$1\t\t\t\t${fileRefId} /* App.entitlements */,\n`);
        }
        // 只改 App 目标的 Debug/Release（以 INFOPLIST_FILE 识别），不影响 SPM 依赖包目标
        return next.replace(/(buildSettings = \{\n)([\s\S]*?)(\n\t\t\t\};)/g, (match, head, body, tail) => {
            if (!body.includes('INFOPLIST_FILE = App/Info.plist;') || body.includes('CODE_SIGN_ENTITLEMENTS')) return match;
            const line = '\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n';
            const patched = body.includes('\t\t\t\tCODE_SIGN_STYLE = ')
                ? body.replace('\t\t\t\tCODE_SIGN_STYLE = ', `${line}\t\t\t\tCODE_SIGN_STYLE = `)
                : line + body;
            return `${head}${patched}${tail}`;
        });
    });
}

// iOS 原生地图控件（SwiftUI Liquid Glass）：源码直接维护在 ios/App/App/，这里只校验存在并补齐工程引用，
// 从不覆盖手写的 Swift 逻辑；重复执行不会产生改动。
const IOS_NATIVE_SOURCES = [
    ['NativeSettingsPlugin.swift', 'A7F1C0DE0000000000000016', 'A7F1C0DE0000000000000026'],
    ['NativeFeedbackPlugin.swift', 'A7F1C0DE0000000000000017', 'A7F1C0DE0000000000000027'],
    ['MapChromeModel.swift', 'A7F1C0DE0000000000000010', 'A7F1C0DE0000000000000020'],
    ['MapChromeView.swift', 'A7F1C0DE0000000000000011', 'A7F1C0DE0000000000000021'],
    ['PassThroughHostView.swift', 'A7F1C0DE0000000000000012', 'A7F1C0DE0000000000000022'],
    ['NativeMapChromePlugin.swift', 'A7F1C0DE0000000000000013', 'A7F1C0DE0000000000000023'],
    ['FoodMapBridgeViewController.swift', 'A7F1C0DE0000000000000014', 'A7F1C0DE0000000000000024']
];

function patchIosNativeChrome() {
    const appDir = resolve(root, 'ios/App/App');
    const pbxproj = resolve(root, 'ios/App/App.xcodeproj/project.pbxproj');
    if (!existsSync(pbxproj)) return;
    const missing = IOS_NATIVE_SOURCES.filter(([name]) => !existsSync(resolve(appDir, name))).map(([name]) => name);
    if (missing.length) {
        throw new Error(`缺少原生地图控件源码：${missing.join('、')}（应位于 ios/App/App/）`);
    }
    patchFile(pbxproj, 'iOS 原生地图控件源码加入工程', (text) => {
        const anchors = {
            buildFile: /(\t\t\S+ \/\* SceneDelegate\.swift in Sources \*\/ = \{isa = PBXBuildFile;[^\n]*\n)/,
            fileRef: /(\t\t\S+ \/\* SceneDelegate\.swift \*\/ = \{isa = PBXFileReference;[^\n]*\n)/,
            groupChild: /(\t\t\t\t\S+ \/\* SceneDelegate\.swift \*\/,\n)/,
            source: /(\t\t\t\t\S+ \/\* SceneDelegate\.swift in Sources \*\/,\n)/
        };
        let next = text;
        for (const [name, fileRefId, buildFileId] of IOS_NATIVE_SOURCES) {
            if (next.includes(`/* ${name} */ = {isa = PBXFileReference;`)) continue;
            for (const [anchor, pattern] of Object.entries(anchors)) {
                if (!pattern.test(next)) throw new Error(`Xcode 工程结构与预期不同，请在 Xcode 中手动添加 ${name}（缺少锚点 ${anchor}）`);
            }
            next = next
                .replace(anchors.buildFile, `$1\t\t${buildFileId} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${name} */; };\n`)
                .replace(anchors.fileRef, `$1\t\t${fileRefId} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };\n`)
                .replace(anchors.groupChild, `$1\t\t\t\t${fileRefId} /* ${name} */,\n`)
                .replace(anchors.source, `$1\t\t\t\t${buildFileId} /* ${name} in Sources */,\n`);
        }
        return next;
    });
    // 根控制器：SceneDelegate 与 Main.storyboard 都应使用 FoodMapBridgeViewController
    const sceneDelegate = resolve(appDir, 'SceneDelegate.swift');
    if (existsSync(sceneDelegate) && !readFileSync(sceneDelegate, 'utf8').includes('FoodMapBridgeViewController')) {
        console.warn('提示：SceneDelegate.swift 未使用 FoodMapBridgeViewController，原生地图控件不会加载');
    }
    const storyboard = resolve(appDir, 'Base.lproj/Main.storyboard');
    patchFile(storyboard, 'Main.storyboard 根控制器', (text) => text.replace(
        'customClass="CAPBridgeViewController" customModule="Capacitor"',
        'customClass="FoodMapBridgeViewController" customModule="App" customModuleProvider="target"'
    ));
}

try {
    if (!only || only === 'android') {
        patchAndroid();
        patchAndroidGradle();
        patchAndroidPlugins();
    }
    if (!only || only === 'ios') {
        patchIosSwiftPackage();
        patchIos();
        patchIosNativeChrome();
    }
    console.log(changes.length ? `已更新：${changes.join('、')}` : '原生工程配置已是最新');
} catch (error) {
    console.error(`原生工程配置失败：${error.message}`);
    process.exit(1);
}
