'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const bridge = {
  invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
  },
  licensePrepare(payload) {
    return ipcRenderer.invoke('license-prepare', payload || {});
  },
  licenseLogin(payload) {
    return ipcRenderer.invoke('license-login', payload || {});
  },
  licenseSignup(payload) {
    return ipcRenderer.invoke('license-signup', payload || {});
  },
  licenseLogout() {
    return ipcRenderer.invoke('license-logout');
  }
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('rootRecordBridge', bridge);
  contextBridge.exposeInMainWorld('rrWeatherIpc', bridge);
} else {
  globalThis.rootRecordBridge = bridge;
  globalThis.rrWeatherIpc = bridge;
}
