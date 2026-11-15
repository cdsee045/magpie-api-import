Promise.resolve(globalThis.magpie?.ready).then(() => {
  document.getElementById('bridge-state').textContent = globalThis.magpie ? '已连接 Magpie。请从插件的“登录”入口开始导入。' : '使用说明预览：请在 Magpie 中安装并登录此插件。';
}).catch(() => { document.getElementById('bridge-state').textContent = '无法连接 Magpie 宿主，请重新打开此面板。'; });
