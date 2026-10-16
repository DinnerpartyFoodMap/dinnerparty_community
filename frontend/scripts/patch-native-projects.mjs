#!/usr/bin/env node
// 为 Capacitor 生成的原生工程补充本项目需要的配置。可重复执行（已存在的内容会跳过）。
//   node scripts/patch-native-projects.mjs            # 处理已存在的 android/ 与 ios/
//   node scripts/patch-native-projects.mjs android    # 只处理 Android
//   node scripts/patch-native-projects.mjs ios        # 只处理 iOS
//
// Android：定位权限、外部链接/地图应用可见性（<queries>）、Android 11/12 照片选择器回补
// iOS：相机/相册/定位用途说明、出口合规声明、隐私清单（PrivacyInfo.xcprivacy）、SPM 版本兼容

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

function patchAndroid() {
    const manifest = resolve(root, 'android/app/src/main/AndroidManifest.xml');
    if (!existsSync(manifest)) {
        console.log('跳过 Android：尚未生成 android/ 工程（npm run cap:add:android）');
        return;
    }
    patchFile(manifest, 'Android 定位权限', (text) => insertBefore(text, '</manifest>', `
    <!-- @capacitor/geolocation -->
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
`, 'android.permission.ACCESS_FINE_LOCATION'));
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
}

const IOS_PLIST_ENTRIES = [
    ['NSCameraUsageDescription', '用于拍摄地点、菜单和行程照片并上传。'],
    ['NSPhotoLibraryUsageDescription', '用于从相册选择地点、头像和行程照片。'],
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

    const privacyTarget = resolve(root, 'ios/App/App/PrivacyInfo.xcprivacy');
    if (!existsSync(privacyTarget)) {
        copyFileSync(resolve(root, 'native/ios/PrivacyInfo.xcprivacy'), privacyTarget);
        changes.push('iOS 隐私清单文件');
    }
    const pbxproj = resolve(root, 'ios/App/App.xcodeproj/project.pbxproj');
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
}

// iOS 原生地图控件（SwiftUI Liquid Glass）：源码直接维护在 ios/App/App/，这里只校验存在并补齐工程引用，
// 从不覆盖手写的 Swift 逻辑；重复执行不会产生改动。
const IOS_NATIVE_SOURCES = [
    ['NativeSettingsPlugin.swift', 'A7F1C0DE0000000000000016', 'A7F1C0DE0000000000000026'],
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
