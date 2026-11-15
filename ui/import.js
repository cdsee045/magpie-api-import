(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let api, state, revealed = false, started = false, queue = Promise.resolve();
  const busy = () => state && ['reading','validating','saving'].includes(state.status);
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
      $('masked-key').textContent = '当前 Key：' + c.maskedKey;
      $('review-wrap').hidden = !c.needsKeyReview;
      if (!c.needsKeyReview) $('review').checked = false;
      $('models').replaceChildren(...c.models.map(model => { const option = document.createElement('option'); option.value = model; return option; }));
    } else { $('key').value = ''; $('key').type = 'password'; revealed = false; $('reveal').textContent = '显示'; }
    $('validation-label').textContent = next.status === 'verified' ? '当前模型已验证' : '尚未验证';
    for (const el of $('editor').querySelectorAll('input,select,button')) el.disabled = busy();
    $('choices').hidden = next.candidates.length < 2 || !next.active;
    $('choices').replaceChildren(...next.candidates.map((candidate, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.disabled = busy();
      button.setAttribute('aria-pressed', String(index === next.selected));
      const label = document.createElement('span'); label.textContent = candidate.name;
      const detail = document.createElement('small'); detail.textContent = candidate.url + ' · ' + candidate.maskedKey;
      button.append(label, detail); button.onclick = () => { $('key').value = ''; send({ type: 'select', index }); }; return button;
    }));
    if (next.confirmation && next.active) {
      $('summary').replaceChildren();
      for (const [label,value] of Object.entries({名称:next.confirmation.name,域名:next.confirmation.domain,Key:next.confirmation.maskedKey,协议:next.confirmation.protocol,验证模型:next.confirmation.model})) {
        const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('summary').append(dt,dd);
      }
      if (!$('confirmation').open) { $('key').value = ''; $('key').type = 'password'; revealed = false; $('reveal').textContent = '显示'; $('confirmation').showModal(); $('confirm').focus(); }
    } else if ($('confirmation').open) $('confirmation').close();
    $('confirm').disabled = next.status === 'saving';
  }
  for (const field of ['name','url','key','model','protocol']) $(field).addEventListener('input', () => {
    const value = $(field).value;
    if (field !== 'key' || value) send({ type:'edit', changes:{[field]:value}, reviewed:false });
  });
  $('review').onchange = () => send({type:'edit',changes:{},reviewed:$('review').checked});
  $('editor').onsubmit = event => { event.preventDefault(); send({type:'verify'}); };
  $('detect').onclick = () => { $('key').value=''; send({type:'detect'}); };
  $('auto').onchange = () => send({type:'auto',value:$('auto').checked});
  $('load-models').onclick = () => send({type:'models'});
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
      await globalThis.magpie?.ready;
      // This field is supplied ONLY by the proposed trusted host integration.
      api = globalThis.magpie?.apiImport;
      if (!api || api.version !== 1) { notice('当前 Magpie 尚未提供自动导入接口，请参阅插件兼容性说明。'); $('detect').disabled=true; $('auto').disabled=true; return; }
      api.subscribe(render);
    } catch { notice('宿主连接失败，请重新打开自定义供应商页面。'); }
  }
  addEventListener('pagehide', () => { $('key').value=''; if ($('confirmation').open) $('confirmation').close(); });
  start();
})();
