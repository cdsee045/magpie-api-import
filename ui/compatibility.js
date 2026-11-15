Promise.resolve(globalThis.magpie?.ready).then(() => {
  document.getElementById('bridge-state').textContent = globalThis.magpie ? '插件已连接宿主，自动导入能力尚不可用。' : '独立预览：未连接 Magpie 宿主。';
}).catch(() => { document.getElementById('bridge-state').textContent = '无法连接 Magpie 宿主，请重新打开此面板。'; });
