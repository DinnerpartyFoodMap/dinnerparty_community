package cc.dinnerparty.foodmap;

import android.Manifest;
import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;

import com.amap.api.location.AMapLocation;
import com.amap.api.location.AMapLocationClient;
import com.amap.api.location.AMapLocationClientOption;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 高德定位 SDK 单次定位（替代 Android 上的 @capacitor/geolocation）。
 * 国内返回 GCJ-02，境外返回 WGS-84，coordType 标明坐标系，由 platform/geolocation.js 统一成 GCJ-02。
 * 高德失败时（如手机上报境外运营商时高德境外接口返回 403、网络或 Key 问题）在剩余时间内改用系统定位，结果为 WGS-84。
 * checkPermissions / requestPermissions 来自 Capacitor 基类，别名与 @capacitor/geolocation 相同。
 * Key 来自 AndroidManifest 的 com.amap.api.v2.apikey（构建时注入 AMAP_ANDROID_KEY，绑定包名与签名 SHA1）。
 */
@CapacitorPlugin(
    name = "AMapLocation",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "coarseLocation", strings = { Manifest.permission.ACCESS_COARSE_LOCATION })
    }
)
public class AMapLocationPlugin extends Plugin {

    private static final int DEFAULT_TIMEOUT_MS = 10000;
    private static final int MIN_TIMEOUT_MS = 1000;
    // 系统定位兜底同时请求这些提供方，先到的结果为准；fused 为 Android 12+ 系统自带的融合定位（不依赖 Google Play 服务）
    private static final String[] SYSTEM_PROVIDERS = { "fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER };

    // SDK 回调、系统定位回调、超时与销毁都在主线程处理，请求状态无需加锁
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<Request> active = new HashSet<>();
    private boolean privacyDeclared = false;

    @PluginMethod
    public void getCurrentPosition(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED
            && getPermissionState("coarseLocation") != PermissionState.GRANTED) {
            call.reject("Location permission was denied", "PERMISSION_DENIED");
            return;
        }
        LocationManager manager = locationManager();
        if (manager != null && !LocationManagerCompat.isLocationEnabled(manager)) {
            call.reject("Location services are not enabled", "SERVICES_DISABLED");
            return;
        }
        int timeout = Math.max(MIN_TIMEOUT_MS, call.getInt("timeout", DEFAULT_TIMEOUT_MS));
        main.post(() -> start(call, timeout));
    }

    private void start(PluginCall call, int timeout) {
        Request request = new Request(call);
        active.add(request);
        main.postDelayed(request.timeoutTask, timeout);

        Context context = getContext().getApplicationContext();
        try {
            // 业务代码（含定位）只在用户同意隐私政策后加载，到这里时政策已展示并获同意。
            if (!privacyDeclared) {
                AMapLocationClient.updatePrivacyShow(context, true, true);
                AMapLocationClient.updatePrivacyAgree(context, true);
                privacyDeclared = true;
            }
            request.client = new AMapLocationClient(context);
        } catch (Exception e) {
            request.fail("AMap location client failed to start: " + e.getMessage(), "AMAP_INIT", null);
            return;
        }

        AMapLocationClientOption option = new AMapLocationClientOption();
        // 只有模糊权限时 SDK 自己降级为模糊定位；低功耗模式在模糊权限下会直接报错 20
        option.setLocationMode(AMapLocationClientOption.AMapLocationMode.Hight_Accuracy);
        // 单次定位并等待 WiFi 刷新，取约 3 秒内最准的一次，而不是立刻返回首个粗略结果
        option.setOnceLocation(true);
        option.setOnceLocationLatest(true);
        option.setNeedAddress(false);
        option.setHttpTimeOut(timeout);

        request.client.setLocationOption(option);
        request.client.setLocationListener(request::onAmapLocation);
        request.client.startLocation();
    }

    @Override
    protected void handleOnDestroy() {
        for (Request request : new HashSet<>(active)) {
            request.finish();
            request.call.reject("Location request cancelled", "ABORTED");
        }
    }

    private LocationManager locationManager() {
        return (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
    }

    private static JSObject position(Location location, String coordType) {
        JSObject result = new JSObject();
        result.put("longitude", location.getLongitude());
        result.put("latitude", location.getLatitude());
        if (location.hasAccuracy()) result.put("accuracy", location.getAccuracy());
        result.put("coordType", coordType);
        result.put("timestamp", location.getTime());
        return result;
    }

    private final class Request {
        final PluginCall call;
        final Runnable timeoutTask = this::onTimeout;
        AMapLocationClient client;
        CancellationSignal fallback;
        int pendingProviders = 0;
        boolean done = false;
        // 高德的失败原因：系统定位也拿不到位置时原样返回
        String failMessage;
        String failCode;
        JSObject failData;

        Request(PluginCall call) {
            this.call = call;
        }

        void onAmapLocation(AMapLocation location) {
            if (done || client == null) return;
            releaseClient();
            if (location == null) {
                fail("AMap returned no location", "AMAP_8", null);
                return;
            }
            int code = location.getErrorCode();
            if (code == AMapLocation.LOCATION_SUCCESS) {
                JSObject result = position(location, location.getCoordType());
                result.put("locationType", location.getLocationType());
                resolve(result);
                return;
            }
            JSObject data = new JSObject();
            data.put("amapCode", code);
            data.put("detail", location.getLocationDetail());
            fail(location.getErrorInfo(), "AMAP_" + code, data);
        }

        // 缺少权限时系统定位同样拿不到，直接返回；其余高德错误先尝试系统定位
        void fail(String message, String code, JSObject data) {
            failMessage = message;
            failCode = code;
            failData = data;
            if (("AMAP_" + AMapLocation.ERROR_CODE_FAILURE_LOCATION_PERMISSION).equals(code) || !startFallback()) {
                rejectWithAmapFailure();
            }
        }

        boolean startFallback() {
            LocationManager manager = locationManager();
            if (manager == null) return false;
            boolean precise = getPermissionState("location") == PermissionState.GRANTED;
            List<String> available = manager.getAllProviders();
            List<String> providers = new ArrayList<>();
            for (String provider : SYSTEM_PROVIDERS) {
                if (LocationManager.GPS_PROVIDER.equals(provider) && !precise) continue;
                if (available.contains(provider) && manager.isProviderEnabled(provider)) providers.add(provider);
            }
            if (providers.isEmpty()) return false;
            Logger.warn(getLogTag(), "AMap location failed (" + failCode + "), falling back to system location " + providers + ": " + failMessage);
            fallback = new CancellationSignal();
            pendingProviders = providers.size();
            for (String provider : providers) {
                if (done) break;
                try {
                    LocationManagerCompat.getCurrentLocation(manager, provider, fallback,
                        ContextCompat.getMainExecutor(getContext()), this::onSystemLocation);
                } catch (RuntimeException e) {
                    // 个别提供方在旧系统上不支持单次请求或需要额外权限，按无结果处理
                    onSystemLocation(null);
                }
            }
            return true;
        }

        void onSystemLocation(Location location) {
            if (done) return;
            if (location != null) {
                JSObject result = position(location, AMapLocation.COORD_TYPE_WGS84);
                result.put("provider", location.getProvider());
                resolve(result);
                return;
            }
            if (--pendingProviders == 0) rejectWithAmapFailure();
        }

        void onTimeout() {
            if (done) return;
            finish();
            call.reject("Location request timed out", "TIMEOUT");
        }

        void resolve(JSObject result) {
            finish();
            call.resolve(result);
        }

        void rejectWithAmapFailure() {
            finish();
            call.reject(failMessage, failCode, failData);
        }

        void finish() {
            done = true;
            active.remove(this);
            main.removeCallbacks(timeoutTask);
            if (fallback != null) fallback.cancel();
            releaseClient();
        }

        void releaseClient() {
            if (client == null) return;
            AMapLocationClient released = client;
            client = null;
            // 不在 SDK 自己的回调栈里销毁客户端
            main.post(() -> {
                released.stopLocation();
                released.onDestroy();
            });
        }
    }
}
