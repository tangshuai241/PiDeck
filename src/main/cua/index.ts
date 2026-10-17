export { captureScreen, cropNativeJpeg, frameToDataUrl, frameBase64Length, DEFAULT_MAX_LONG_EDGE, DEFAULT_QUALITY, THUMBNAIL_REQUEST_SIZE, type CaptureOptions, type Frame } from "./CuaFrame";
export { listCuaDisplays, findCuaDisplay, type CuaDisplayInfo } from "./CuaDisplays";
export {
	imagePointToScreen,
	screenPointToImage,
	imageRectToScreenRect,
	resolveScreenPoint,
	clampImageRect,
	imageRectToNativeRect,
	cropFrameGeometry,
	matchMonitorToDisplay,
	describeFrameGeometry,
	isValidGeometry,
	type CuaFrameGeometry,
	type CuaGeometryResult,
	type CuaGeometryFailure,
	type CuaImageRect,
	type CuaMonitorRect,
	type CuaPoint,
	type CuaRect,
} from "./CuaGeometry";
export { CuaFrameRegistry, DEFAULT_FRAME_LIMIT, DEFAULT_FRAME_TTL_MS, type CuaRegisteredFrame, type CuaFrameRegistryOptions } from "./CuaFrames";
export { CuaScreen, type CuaCaptureOptions, type CuaCaptureOutcome, type CuaZoomOptions, type CuaZoomOutcome, type CuaScreenDeps } from "./CuaScreen";
export {
	enumerateWindows,
	moveMouseAbsolute,
	clickAt,
	buildMouseInput,
	buildKeyboardInput,
	sendInputs,
	normalizeAbsoluteCoordinate,
	pressKeyCombo,
	typeUnicode,
	scrollAt,
	VK_MAP,
	INPUT_MOUSE,
	INPUT_KEYBOARD,
	MOUSEEVENTF_LEFTDOWN,
	MOUSEEVENTF_LEFTUP,
	MOUSEEVENTF_RIGHTDOWN,
	MOUSEEVENTF_RIGHTUP,
	MOUSEEVENTF_MIDDLEDOWN,
	MOUSEEVENTF_MIDDLEUP,
	MOUSEEVENTF_ABSOLUTE,
	MOUSEEVENTF_VIRTUALDESK,
	MOUSEEVENTF_WHEEL,
	MOUSEEVENTF_HWHEEL,
	KEYEVENTF_KEYUP,
	KEYEVENTF_UNICODE,
	HWND_TOPMOST,
	HWND_NOTOPMOST,
	SW_RESTORE,
	SWP_NOMOVE,
	SWP_NOSIZE,
	SWP_NOACTIVATE,
	SWP_SHOWWINDOW,
	type WindowInfo,
} from "./CuaWin32";
export { analyzeWindows, findWindowByTitle, getPrimaryDisplay, getForegroundWindowInfo, type OcclusionInfo, type DisplayInfo } from "./CuaWindowAnalyzer";
export { CuaGate, type CuaActionType, type CuaActionMeta, type CuaGateDecision, type CuaGateConfig, type CuaApprovalRequest, type CuaApprovalResponse } from "./CuaGate";
export { CuaEngine, type CuaActionOptions, type CuaEngineConfig, type CuaActionResult } from "./CuaEngine";
export { createCuaMcpServer } from "./CuaMcpServer";
export { registerCuaTools } from "./CuaTools";
export { CuaMcpHttpHost, type CuaMcpHttpHostConfig, type CuaMcpHttpHostDeps } from "./CuaMcpHttpHost";
export { ensureCuaMcpRegistered, unregisterCuaMcp, type CuaMcpRegistration } from "./CuaMcpRegistration";
export { CuaIpcManager, registerCuaIpc, type CuaIpcDeps } from "../ipc/cuaIpc";
