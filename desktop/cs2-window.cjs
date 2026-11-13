const { win32 } = require('node:path');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' });
koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });

const foregroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const isMinimized = user32.func('int __stdcall IsIconic(void *window)');
const windowProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32_t *pid)');
const clientRect = user32.func('int __stdcall GetClientRect(void *window, _Out_ RECT *rect)');
const clientToScreen = user32.func('int __stdcall ClientToScreen(void *window, _Inout_ POINT *point)');
const setDpiContext = user32.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)');
const setWindowPosition = user32.func('int __stdcall SetWindowPos(uintptr_t window, intptr_t after, int x, int y, int width, int height, uint32_t flags)');
const windowStyle = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t window, int index)');
const openProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const processImage = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint16_t *path, _Inout_ uint32_t *length)');
const closeHandle = kernel32.func('int __stdcall CloseHandle(void *handle)');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
const HWND_TOPMOST = -1;
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x0008n;
const SWP_KEEP_BOUNDS_WITHOUT_ACTIVATING = 0x0001 | 0x0002 | 0x0010;
const imagePath = Buffer.alloc(32768 * 2);

function isCs2(pid) {
  const process = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!process) return false;
  try {
    const length = [imagePath.length / 2];
    if (!processImage(process, 0, imagePath, length)) return false;
    return win32.basename(imagePath.toString('utf16le', 0, length[0] * 2)).toLowerCase() === 'cs2.exe';
  } finally {
    closeHandle(process);
  }
}

function getCs2Bounds() {
  const window = foregroundWindow();
  const pid = [0];
  if (!window || isMinimized(window) || !windowProcessId(window, pid) || !isCs2(pid[0])) return null;

  // Electron converts this physical-pixel rectangle into its own DIP coordinates.
  const previousContext = setDpiContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  try {
    const rect = {};
    if (!clientRect(window, rect)) return null;
    const origin = { x: rect.left, y: rect.top };
    const end = { x: rect.right, y: rect.bottom };
    if (!clientToScreen(window, origin) || !clientToScreen(window, end)) return null;
    const width = end.x - origin.x;
    const height = end.y - origin.y;
    return width > 0 && height > 0 ? { x: origin.x, y: origin.y, width, height } : null;
  } finally {
    if (previousContext) setDpiContext(previousContext);
  }
}

function keepOverlayOnTop(handle) {
  // The buffer is the HWND of our own Electron window, never the game window.
  const window = handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE();
  if ((BigInt(windowStyle(window, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0n) return true;
  return Boolean(setWindowPosition(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_KEEP_BOUNDS_WITHOUT_ACTIVATING));
}

module.exports = { getCs2Bounds, keepOverlayOnTop };
