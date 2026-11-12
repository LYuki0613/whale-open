const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whaleNative', {
  // 原生选文件（PC 端专用，比 <input type=file> 可靠）
  pickFiles: (opts) => ipcRenderer.invoke('pick-files', opts ?? {}),
  isDesktop: true,
  // 桌面通知（右下角弹窗）
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  winState: () => ipcRenderer.invoke('win-state'),
});
