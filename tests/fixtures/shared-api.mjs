// Synthetic credentials only. Matches a forum post with two URLs and wrapped keys.
export const urls = ['https://api.example.test', 'https://cdn.example.test'];
export const keys = [1, 2, 3].map(i => `sk-fixture_${i}_` + 'abcdef1234567890'.repeat(3));
export const models = [['fixture-one', 'fixture-one-alt'], ['fixture-model', 'fixture-two-alt'], ['fixture-three']];
export function sharedText(addresses = urls) {
  const header = `url: ↗ ${addresses[0]}/ 49\nurl（CDN加速）： ↗ ${addresses[1]}/ 31`;
  return header + '\n\n' + keys.map((key, i) => {
    const encoded = Buffer.from(key).toString('base64');
    return `key${i + 1}(BASE64):\n${encoded.slice(0, 70)}\n${encoded.slice(70)}\n可用模型: ${models[i].join(' | ')}`;
  }).join('\n\n') + '\n\n支持: Example Client、Example Tool';
}
