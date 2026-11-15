(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let api, state, revealed = false, started = false, queue = Promise.resolve(), encodedVersion = 0;
  const busy = () => state && ['reading','validating','saving'].includes(state.status);
  function clearEncoded() { encodedVersion++; if ($('encoded-key')) { $('encoded-key').value = ''; $('encoded-editor').hidden = true; } }
  function notice(message) { $('notice').hidden = !message; $('notice').textContent = message; }
  async function send(command) {
    if (!api) return;
    const pending = queue.then(() => api.command(command));
    queue = pending.catch(() => {});
    try { await pending; } catch { notice('操作未完成，请在当前页面重试。'); }
  }
  function render(next) {
    state = next;
    $('auto').checked = next.auto;
    $('detect').disabled = busy();
    $('auto').disabled = next.status === 'saving';
    $('notice').dataset.status = next.status;
    notice(next.message);
    const c = next.candidates[next.selected];
    $('editor').hidden = !c || !next.active || ['saved','dismissed'].includes(next.status);
    if (c) {
      for (const field of ['name','url','protocol','model']) if (document.activeElement !== $(field)) $(field).value = c[field];
      const urlPicker = $('url-picker'), urls = c.urlOptions || [];
      if (urlPicker) {
        urlPicker.hidden = urls.length < 2;
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '识别到多个地址，请选择主站或 CDN 地址';
        urlPicker.replaceChildren(placeholder, ...urls.map(url => { const option = document.createElement('option'); option.value = url; option.textContent = url; return option; }));
        urlPicker.value = urls.includes(c.url) ? c.url : '';
      }
      $('masked-key').textContent = '当前 Key：' + c.maskedKey;
      if ($('encoded-wrap')) $('encoded-wrap').hidden = !c.hasEncodedKey;
      $('review-wrap').hidden = !c.needsKeyReview;
      if (!c.needsKeyReview) $('review').checked = false;
      $('models').replaceChildren(...c.models.map(model => { const option = document.createElement('option'); option.value = model; return option; }));
      const picker = $('model-picker');
      if (picker) {
        picker.hidden = !c.models.length;
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = `从识别或获取的 ${c.models.length} 个模型中选择`;
        picker.replaceChildren(placeholder, ...c.models.map(model => { const option = document.createElement('option'); option.value = model; option.textContent = model; return option; }));
        picker.value = c.models.includes(c.model) ? c.model : '';
      }
    } else { $('key').value = ''; $('key').type = 'password'; revealed = false; $('reveal').textContent = '显示'; clearEncoded(); }
    $('validation-label').textContent = next.status === 'verified' ? '当前模型已验证' : '尚未验证';
    for (const el of $('editor').querySelectorAll('input,select,textarea,button')) el.disabled = busy();
    $('choices').hidden = next.candidates.length < 2 || !next.active;
    $('choices').replaceChildren(...next.candidates.map((candidate, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.disabled = busy();
      button.setAttribute('aria-pressed', String(index === next.selected));
      const label = document.createElement('span'); label.textContent = candidate.name;
      const detail = document.createElement('small'); detail.textContent = (candidate.url || '请选择 API 地址') + ' · ' + candidate.maskedKey;
      button.append(label, detail); button.onclick = () => { $('key').value = ''; clearEncoded(); send({ type: 'select', index }); }; return button;
    }));
    if (next.confirmation && next.active) {
      $('summary').replaceChildren();
      for (const [label,value] of Object.entries({名称:next.confirmation.name,域名:next.confirmation.domain,Key:next.confirmation.maskedKey,协议:next.confirmation.protocol,验证模型:next.confirmation.model})) {
        const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('summary').append(dt,dd);
      }
      if (!$('confirmation').open) { $('key').value = ''; $('key').type = 'password'; revealed = false; $('reveal').textContent = '显示'; clearEncoded(); $('confirmation').showModal(); $('confirm').focus(); }
    } else if ($('confirmation').open) $('confirmation').close();
    $('confirm').disabled = next.status === 'saving';
  }
  for (const field of ['name','url','key','model','protocol']) $(field).addEventListener('input', () => {
    const value = $(field).value;
    if (field !== 'key' || value) send({ type:'edit', changes:{[field]:value}, reviewed:false });
  });
  $('review').onchange = () => send({type:'edit',changes:{},reviewed:$('review').checked});
  $('editor').onsubmit = event => { event.preventDefault(); send({type:'verify'}); };
  $('detect').onclick = () => { $('key').value=''; clearEncoded(); send({type:'detect'}); };
  $('auto').onchange = () => send({type:'auto',value:$('auto').checked});
  $('load-models').onclick = () => send({type:'models'});
  if ($('encoded-reveal')) $('encoded-reveal').onclick = async () => {
    const version = encodedVersion;
    try {
      await queue; const encoded = await api.revealEncodedKey();
      if (version !== encodedVersion || document.hidden || !state?.active) return;
      $('encoded-key').value = encoded; $('encoded-editor').hidden = false;
    }
    catch { notice('无法读取编码，请重新检测。'); }
  };
  if ($('decode-key')) $('decode-key').onclick = () => send({type:'decode',encoded:$('encoded-key').value});
  if ($('url-picker')) $('url-picker').onchange = event => {
    if (!event.target.value) return;
    $('url').value = event.target.value;
    send({type:'edit',changes:{url:event.target.value},reviewed:false});
  };
  if ($('model-picker')) $('model-picker').onchange = event => {
    if (!event.target.value) return;
    $('model').value = event.target.value;
    send({type:'edit',changes:{model:event.target.value},reviewed:false});
  };
  $('cancel').onclick = () => send({type:'dismiss'});
  $('confirmation').addEventListener('cancel', event => { event.preventDefault(); send({type:'dismiss'}); });
  $('confirm').onclick = () => { $('confirm').disabled=true; send({type:'confirm'}); };
  $('reveal').onclick = async () => {
    if (!api) return;
    if (revealed) { $('key').value=''; $('key').type='password'; revealed=false; $('reveal').textContent='显示'; return; }
    try { await queue; $('key').value = await api.revealKey(); $('key').type='text'; revealed=true; $('reveal').textContent='隐藏'; }
    catch { notice('无法显示 Key，请重新检测。'); }
  };
  async function start() {
    if (started) return; started=true;
    try {
      // This is the plugin's own loopback client, never an invented Magpie API.
      api = globalThis.apiImport;
      if (!api || api.version !== 1) { notice('导入会话未连接，请返回 Magpie 重新登录。'); $('detect').disabled=true; $('auto').disabled=true; return; }
      api.subscribe(render);
    } catch { notice('导入连接失败，请返回 Magpie 重新登录。'); }
  }
  addEventListener('pagehide', () => { $('key').value=''; clearEncoded(); if ($('confirmation').open) $('confirmation').close(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearEncoded(); });
  $('parse-input')?.addEventListener('click', clearEncoded);
  start();
})();
