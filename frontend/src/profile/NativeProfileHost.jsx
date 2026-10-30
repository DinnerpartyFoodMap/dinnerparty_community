// 原生住民主页的宿主：不渲染任何网页界面，只负责驱动原生主页与执行它交回的请求。
// 原生不可用或加载失败时由 App 切回网页 UserProfilePage。
import useNativeProfile from './useNativeProfile';

export default function NativeProfileHost(props) {
    useNativeProfile(props);
    return null;
}
