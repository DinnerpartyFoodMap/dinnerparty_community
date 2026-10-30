// 原生管理后台宿主：不渲染网页界面，只驱动原生页面与执行它交回的请求。
import useNativeAdmin from './useNativeAdmin';

export default function NativeAdminHost(props) {
    useNativeAdmin(props);
    return null;
}
