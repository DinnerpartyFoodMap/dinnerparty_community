// 平台能力接口汇总。业务组件只依赖这些能力，不直接判断 Web / Android / iOS。
export { isNativePlatform, getPlatform, getClientInfo, APP_VERSION } from './env.js';
export { getRuntimeConfig, getApiBaseUrl, buildPublicUrl, resolveResourceUrl, imageThumbnailUrl } from './runtimeConfig.js';
export { loadAmap, retryAmap, subscribeAmap, getAmapState, describeAmapError } from './amapLoader.js';
export { getCurrentPath, getQueryParams, navigate, goBack, canGoBack, onPopState, openExternal, removeQueryParams } from './navigation.js';
export { useBackHandler, pushBackHandler, dispatchBack, BACK_PRIORITY } from './backButton.js';
export { onAppStateChange, isAppActive } from './lifecycle.js';
export { peekToken, restoreToken, saveToken, clearToken, subscribeExternalTokenChanges, needsRestore, decodeTokenPayload, getTokenUserId } from './credentialStore.js';
export { getCurrentLocation, describeLocationError, isLocationAvailable, LocationError, LOCATION_ERROR, releaseLocationControl } from './geolocation.js';
export { pickImages, prepareImageForUpload, pickPreparedImages, UPLOAD_LIMITS, MediaError } from './mediaPicker.js';
export { shareContent, shareOrCopy, copyText, saveBlob, saveImageBlob, shareImageBlob, canShare, describeShareResult } from './share.js';
export { saveLocalDraft, loadLocalDraft, deleteLocalDraft, clearLocalDraftsForUser, requestPersistentStorage } from './localDraftStore.js';
export { initPlatform, toInAppPath } from './nativeShell.js';
