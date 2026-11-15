(() => {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  const listeners = new Set();
  let timer, last = '', ended = false, selectedImage, processing = false, polling = false;
  const $ = id => document.getElementById(id);
  async function call(path, body, keepalive = false) {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', keepalive,
      headers: { 'X-API-Import': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw Error('本次导入未完成，请返回 Magpie 重试。');
    return response.json();
  }
  async function poll() {
    if (polling || ended) return;
    polling = true;
    try {
      const state = await call('state');
      const text = JSON.stringify(state);
      if (last !== text) { last = text; for (const listener of listeners) listener(state); }
      if (state.status === 'saved') { ended = true; clearInterval(timer); $('parse-input').disabled = true; }
    } catch { if (!ended) $('input-notice').textContent = '导入连接已关闭，请返回 Magpie 重新登录。'; }
    finally { polling = false; }
  }
  globalThis.apiImport = {
    version: 1,
    async command(command) { await call('command', command); await poll(); },
    async revealKey() { return (await call('key', {})).key; },
    subscribe(listener) { listeners.add(listener); if (last) listener(JSON.parse(last)); void poll(); timer ??= setInterval(poll, 300); return () => listeners.delete(listener); },
  };
  function selectImage(file) {
    if (processing || ended) return;
    if (file.size > 20 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { $('input-notice').textContent = '请选择小于 20 MB 的 PNG、JPEG 或 WebP 图片。'; return; }
    selectedImage = file; $('input-text').value = ''; $('clear-image').hidden = false;
    $('input-notice').textContent = '已选择截图，点击“识别并验证”后在本机识别。';
  }
  $('image-file').onchange = event => { const file = event.target.files[0]; if (file) selectImage(file); };
  $('clear-image').onclick = () => { selectedImage = undefined; $('image-file').value = ''; $('clear-image').hidden = true; $('input-notice').textContent = '可粘贴文字、JSON 或截图。'; };
  $('input-text').addEventListener('paste', event => {
    const image = [...(event.clipboardData?.items ?? [])].find(item => item.type.startsWith('image/'))?.getAsFile();
    if (image) { event.preventDefault(); selectImage(image); }
    else { selectedImage = undefined; $('image-file').value = ''; $('clear-image').hidden = true; }
  });
  async function pngBase64(file) {
    let data;
    if (file.type === 'image/png') data = await file.arrayBuffer();
    else {
      const image = await createImageBitmap(file);
      try {
        if (image.width * image.height > 25_000_000) throw Error('图片过大，请裁剪 API 信息区域。');
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!png || png.size > 20 * 1024 * 1024) throw Error('图片过大，请裁剪 API 信息区域。');
        data = await png.arrayBuffer();
      } finally { image.close(); }
    }
    const bytes = new Uint8Array(data); let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    return btoa(binary);
  }
  $('parse-input').onclick = async () => {
    if (processing || ended) return;
    processing = true; $('parse-input').disabled = true;
    try {
      const body = selectedImage ? { kind: 'image', png: await pngBase64(selectedImage) } : { kind: 'text', text: $('input-text').value };
      if (body.kind === 'text' && !body.text.trim()) { $('input-notice').textContent = '请先粘贴 API 信息或选择截图。'; return; }
      await call('input', body);
      $('input-text').value = ''; selectedImage = undefined; $('image-file').value = ''; $('clear-image').hidden = true;
      $('input-notice').textContent = '输入已交给本机识别，原始内容已从输入框清空。';
      await globalThis.apiImport.command({ type: 'detect' });
    } catch { $('input-notice').textContent = '识别未完成，请检查图片大小或重新粘贴文字。'; }
    finally { processing = false; $('parse-input').disabled = ended; }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { $('key').value = ''; $('key').type = 'password'; if ($('confirmation').open) $('confirmation').close(); }
    if (!ended) void call(document.hidden ? 'suspend' : 'resume', {}, true).then(poll).catch(() => {});
  });
  addEventListener('pagehide', () => {
    clearInterval(timer); $('input-text').value = ''; selectedImage = undefined;
    if (!ended) void call('cancel', {}, true).catch(() => {});
  });
})();
