// 原生日记 · 同好宿主：不渲染网页界面，只驱动原生页面与执行它交回的请求。
import useNativeJourney from './useNativeJourney';

export default function NativeJourneyHost(props) {
    useNativeJourney(props);
    return null;
}
