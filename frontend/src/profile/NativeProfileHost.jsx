// 原生住民主页的宿主：驱动原生主页、执行它交回的请求。网页界面只有小伙伴的起名 / 编辑表单：
// 开在原生主页底下（全屏、短渐变），原生淡出后露出来，关掉时原生先淡入（见 useNativeProfile 的 editCompanion）。
// 原生不可用或加载失败时由 App 切回网页 UserProfilePage。
import React from 'react';
import useNativeProfile from './useNativeProfile';
import RoomNameFlow from '../companion/RoomNameFlow';
import RoomSheetEditor from '../companion/RoomSheetEditor';

const UNDER_NATIVE_PANEL = Object.freeze({ mobile: 'full', presetOptions: { reduced: true } });

export default function NativeProfileHost(props) {
    const { roomEditor, finishRoomEditor } = useNativeProfile(props);
    const editor = roomEditor || {};
    const shared = { me: editor.me, cities: editor.cities || [], backendUrl: props.backendUrl, token: props.token, panel: UNDER_NATIVE_PANEL };
    return <>
        <RoomNameFlow {...shared} open={!!editor.open && editor.mode === 'name'}
            onClose={() => finishRoomEditor(null)} onNamed={() => finishRoomEditor('named')} />
        <RoomSheetEditor {...shared} open={!!editor.open && editor.mode === 'edit'}
            onClose={() => finishRoomEditor(null)} onSaved={() => finishRoomEditor('saved')} />
    </>;
}
