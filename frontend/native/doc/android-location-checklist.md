# Android 定位复现与回归（2026-10-21）

环境：Android Studio，本机 AVD `Medium_Phone_API_37.0`（Android API 37、x86_64、Google Play 镜像），应用 2.2.3 debug，Capacitor Geolocation 8.2.2。先通过 adb 卸载旧版，再安装当前代码构建的基线 APK；修复后重新构建安装。权限状态通过 adb 设置，未人工操作系统授权弹窗。

## 已确认的问题

基线仅授予 `ACCESS_COARSE_LOCATION` 时，`checkPermissions` 返回 `coarseLocation: granted, location: prompt`。前端仍传入 `enableHighAccuracy: true`，插件再次请求精确位置，系统显示从模糊升级为精确的授权框，定位请求等待该弹窗。此行为已在模拟器复现，但不能据此认定全部用户反馈均来自此原因。

修复按已授予的权限选择精度；只有精确权限已授予时才请求高精度。原生权限检查和获取位置另外设置 JS 超时，避免原生不回调时永久锁住定位按钮；地图取消请求时停止等待并忽略迟到结果。用户回答授权弹窗的时间不计入获取位置的超时。

## 本次结果

| 场景 | 实际结果 |
| --- | --- |
| 基线、仅模糊权限 | 再次弹出升级精确位置的系统提示，已复现 |
| 修复版、仅模糊权限 | `enableHighAccuracy: false`，返回 accuracy 2000 m 的位置并显示蓝点，无二次授权 |
| 修复版、精确权限 | 返回 accuracy 5 m 的模拟位置，显示蓝点 |
| 基线与修复版、停用 Google Play Services、精确权限 | 均能返回模拟位置；未复现无 GMS 必然失败，不更改插件或定位提供方 |
| 修复版、原生定位不回调（WebView 调试注入挂起 Promise） | 按钮先 disabled；约 10 秒报定位超时并恢复 enabled；恢复原生回调后再次点击定位成功 |
| 修复版、系统定位总开关关闭 | 原生返回 OS-PLUG-GLOC-0007，手动定位进入已有“设备定位服务未开启”错误处理，按钮恢复 |
| 修复版、精确与模糊权限均拒绝且固定拒绝 | 启动自动定位按既有行为静默失败；手动点击进入已有“定位权限被拒绝”错误处理，按钮恢复 |

错误分支以原生日志和前端日志核对；未将瞬时提示条的视觉表现算作截图验收。无回调是故障注入，不代表在模拟器上发现了真实设备原生回调丢失。

## 自动化与构建

- `npm test`：前端完整测试通过。
- `npm run test:platform`：原生测试经过真实 Capacitor JS 代理，只替换 `nativePromise` 设备边界；覆盖精确/模糊权限、获取位置无回调、权限检查无回调、取消与迟到结果、授权等待不占用定位超时。
- `npm run build:mobile` → `npx cap sync android` → `gradlew.bat :app:assembleDebug`：成功。构建仍有原有分包体积和混用静态/动态导入提示。
- 首次移动构建遇到系统临时目录 esbuild 文件删除 Access denied，改用仓库忽略目录下的任务临时目录后构建成功，无需修改构建配置。

## 后续真机回归

仍需报告问题的厂商真机型号、Android/WebView 版本与授权状态。重点检查仅模糊权限、拒绝后去设置恢复、室内 GPS 冷启动、无 GMS、系统定位关闭及定位中离开地图。模拟器位置注入与 JS 替身不能证明厂商定位服务、真实 GPS 信号或全部 Android 版本兼容。

测试结束恢复模拟器定位总开关、Google Play Services 与应用定位权限；WebView 故障注入在进程重启后清除。

## 改用高德定位 SDK（2026-10-21）

Android 定位改由应用内插件 `AMapLocation`（`android/app/src/main/java/cc/dinnerparty/foodmap/AMapLocationPlugin.java`，`com.amap.api:location:11.3.000`）完成，`@capacitor/geolocation` 只保留给 iOS，并通过 `capacitor.config.json` 的 `android.includePlugins` 从 Android 工程排除（APK 不再包含 play-services-location）。上面的 JS 超时、取消、授权等待规则保持不变；权限别名与旧插件相同。插件每次定位新建单次定位客户端（高精度模式 + 等待 WiFi 刷新），返回后或超时即销毁；国内结果为 GCJ-02 直接使用，境外 WGS-84 由 JS 转换。Key 与 SHA1 配置见 `docs/MOBILE_DEVELOPMENT.md` 第 5 节。

同一 AVD（x86_64，带 ARM 转译），未配置真实 Key，结果：

| 场景 | 实际结果 |
| --- | --- |
| 默认安装（x86_64） | SDK 的 `libapssdk.so` 只有 ARM 版本，加载失败；返回错误 4（#0403），前端显示定位超时，按钮恢复 |
| `adb install --abi arm64-v8a`，空 Key、精确权限 | so 正常加载，服务器拒绝，错误 4（#0403） |
| ARM 安装，错误 Key、精确权限 | 错误 7 `INVALID_USER_KEY`，详细信息含 SDK 看到的签名 SHA1 与包名；前端显示“定位失败” |
| 首次授权选择“大致位置” | 一次系统授权，无升级精确位置的二次弹窗；返回 locationType 11、accuracy 2000 m 的 GCJ-02 位置并显示蓝点（模糊定位不经 Key 鉴权） |
| 系统定位总开关关闭 | 插件直接返回 `SERVICES_DISABLED`，不启动 SDK |
| 同意隐私政策前 | 只注册插件，无高德定位请求 |

首次实现在仅模糊权限时使用低功耗模式，SDK 返回错误 20“模糊权限下不支持低功耗定位”；已改为始终使用高精度模式，由 SDK 按权限降级。

### 配置真实 Key 后（同日）

Key 写在 `android/local.properties`，调试签名 SHA1 已绑定；ARM 安装（`--abi arm64-v8a`）。模拟器默认上报美国运营商（`gsm.operator.iso-country=us`），SDK 因此走境外接口 `abroad-lzd.apilocate.amap.com`；开启飞行模式、只开 WiFi 后不再上报运营商，SDK 改走国内接口 `a.apilocate.amap.com`。

| 场景 | 实际结果 |
| --- | --- |
| 国内接口、精确权限、注入 WGS-84 116.397, 39.908 | 启动自动定位与手动点击均成功：locationType 1（GPS），accuracy 5 m，GCJ-02 116.40325, 39.90940，蓝点落在南池子大街 |
| 国内接口、仅模糊权限 | locationType 11，accuracy 2000 m，显示蓝点，无二次授权 |
| 系统定位总开关关闭 | 提示“设备定位服务未开启”，按钮恢复 |
| 首次授权选择“不允许” | 启动自动定位静默失败；再点定位按钮，系统直接拒绝（未再弹窗），提示“定位权限被拒绝” |
| 境外接口（美国运营商）、精确权限、GPS 已注入 | 约 2 秒返回错误 4（#0403），前端提示定位超时；GPS 位置没有被用上 |

最后一行意味着：手机上报境外运营商时（如在境外用当地或漫游网络），网络定位请求会被高德拒绝，单次定位先返回这个错误，GPS 可用也会失败。原因推测是当前 Key 没有开通高德的海外定位，未向高德确认。改用高德之前，系统定位在境外可用。

### 系统定位兜底（同日）

高德返回任何错误（缺少权限的错误 12 除外）或客户端启动失败时，插件在同一超时内改用系统 `LocationManager`：同时请求已开启的 fused（Android 12+ 系统融合定位，不依赖 Google Play 服务）、gps（仅精确权限）、network，先到的结果为准，按 WGS-84 返回由 JS 转换；都拿不到位置时返回原来的高德错误。日志 `Capacitor/AMapLocationPlugin` 会记下高德的错误码和改用的提供方。

| 场景 | 实际结果 |
| --- | --- |
| 美国运营商、北京 GPS | 高德约 2 秒返回 403，改用 [fused, gps]；gps 返回 WGS-84 116.397, 39.908，转换后蓝点与高德成功时位置一致 |
| 美国运营商、东京站 GPS（139.7671, 35.6812） | 同样兜底，gps 返回东京坐标，境外不转换，地图移到东京 |
| 飞行模式只开 WiFi、重新启动 App、北京 GPS | 走国内接口，高德自己返回 locationType 1、GCJ-02，未触发兜底 |

测试中观察到两点，均来自模拟器瞬移位置：
- 系统 `getCurrentLocation` 可能返回约 30 秒内的缓存位置。刚把注入位置从北京改到东京就定位，fused 先返回了北京的旧位置；等 30 秒后正常。正常移动时影响不大，高速移动中兜底位置可能落后几百米到几公里。
- 同一进程里上一次定位在境外后，高德仍走境外接口（403 → 兜底）；重新启动 App 后恢复国内接口。从境外回国后的第一次定位可能走兜底，结果仍然可用。

**仍未验证**：真机 GPS/WiFi/基站定位、发布包签名下的鉴权、真实境外网络。至少在一台国内真机上复测精确、模糊、拒绝、系统定位关闭四种状态。
