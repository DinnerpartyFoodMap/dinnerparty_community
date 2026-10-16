// 记下最近一次“定位”的位置并上报后端（PUT /users/me/location），QQ Bot 的 !随机 以它为中心。
// App 启动时的自动定位常常早于登录状态恢复：定位结果先留着，登录（或换账号）后补报一次；
// 同一个位置对同一个通行凭证只报一次，失败后下次登录状态变化或再次定位时重试。
export function createLocationReporter(send) {
    let auth = { isAuthenticated: false, token: null, backendUrl: '' };
    let pending = null;

    function flush() {
        const current = pending;
        if (!current || !auth.isAuthenticated || !auth.token || current.reportedToken === auth.token) return;
        current.reportedToken = auth.token;
        Promise.resolve()
            .then(() => send(auth.backendUrl, auth.token, { lat: current.lat, lng: current.lng }))
            .catch((error) => {
                if (pending === current) current.reportedToken = null;
                console.warn("记录定位失败", error);
            });
    }

    return {
        setAuth(next) {
            auth = { isAuthenticated: !!next.isAuthenticated, token: next.token || null, backendUrl: next.backendUrl || '' };
            flush();
        },
        located({ lat, lng }) {
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            pending = { lat, lng, reportedToken: null };
            flush();
        }
    };
}
