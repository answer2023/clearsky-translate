import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseLLMArray, parseGoogleBatch, parseGoogleSingle, chunkTexts } from '../../lib/engine-utils.js';
const require = createRequire(import.meta.url);
const Subs = require('../../lib/subs.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('✓', name); };

t('LLM 标准 JSON', () => assert.deepEqual(parseLLMArray('{"t":["你好","世界"]}', 2), ['你好', '世界']));
t('LLM 代码块+思考段', () => assert.deepEqual(parseLLMArray('<think>hmm</think>\n```json\n{"t":["甲"]}\n```', 1), ['甲']));
t('LLM 纯数组带前缀', () => assert.deepEqual(parseLLMArray('Sure: ["a","b"]', 2), ['a', 'b']));
t('LLM 其它键名', () => assert.deepEqual(parseLLMArray('{"translations":["x","y"]}', 2), ['x', 'y']));
t('LLM 数字键对象', () => assert.deepEqual(parseLLMArray('{"1":"b","0":"a"}', 2), ['a', 'b']));
t('LLM 条数不符返回 null', () => assert.equal(parseLLMArray('{"t":["a"]}', 2), null));
t('谷歌单条', () => assert.equal(parseGoogleSingle([[['你好，','Hello, '],['世界','world']],null,'en']), '你好，世界'));
t('谷歌批量-字符串', () => assert.deepEqual(parseGoogleBatch(['a', 'b'], 2), ['a', 'b']));
t('谷歌批量-二元组', () => assert.deepEqual(parseGoogleBatch([['a', 'en'], ['b', 'en']], 2), ['a', 'b']));
t('谷歌批量-异常', () => assert.equal(parseGoogleBatch(['a', 'en'], 3), null));
t('切分批次', () => assert.deepEqual(chunkTexts(['aa', 'bb', 'cc', 'dd'], 3, 5).map((c) => c.length), [2, 2]));

// ASR 逐词字幕
const asr = { events: [
  { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'so' }, { utf8: ' today', tOffsetMs: 300 }, { utf8: ' we', tOffsetMs: 600 }, { utf8: ' talk', tOffsetMs: 900 }, { utf8: ' about', tOffsetMs: 1200 }, { utf8: ' insurance', tOffsetMs: 1500 }] },
  { tStartMs: 1800, aAppend: 1, dDurationMs: 10, segs: [{ utf8: '\n' }] },
  { tStartMs: 4000, dDurationMs: 3000, segs: [{ utf8: 'it' }, { utf8: ' matters', tOffsetMs: 200 }, { utf8: ' a', tOffsetMs: 400 }, { utf8: ' lot.', tOffsetMs: 600 }] },
  { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: 'Next' }, { utf8: ' topic', tOffsetMs: 300 }] }
] };
const pa = Subs.parseTimedtext(JSON.stringify(asr));
t('ASR 断句', () => {
  assert.deepEqual(pa.cues.map((c) => c.text), ['so today we talk about insurance', 'it matters a lot.', 'Next topic']);
  assert.equal(pa.cues[0].start, 0);
  assert.ok(pa.cues[0].end <= 4000);
});
// 手动字幕 json3
const man = { events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello\nthere' }] }, { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'Bye &amp; see you' }] }] };
const pm = Subs.parseTimedtext(JSON.stringify(man));
t('手动字幕', () => assert.deepEqual(pm.cues.map((c) => c.text), ['Hello there', 'Bye & see you']));
t('srv3 XML', () => assert.deepEqual(Subs.parseTimedtext('<timedtext><body><p t="0" d="1500">Hi <s>you</s></p><p t="1500" d="900">Ok&#39;s</p></body></timedtext>').cues.map((c) => c.text), ['Hi you', "Ok's"]));
t('旧 XML', () => assert.equal(Subs.parseTimedtext('<transcript><text start="1.5" dur="2">A &amp;amp; B</text></transcript>').cues[0].start, 1500));
t('findCue', () => {
  assert.equal(Subs.findCue(pm.cues, 1500), 0);
  assert.equal(Subs.findCue(pm.cues, 3500), 1);
  assert.equal(Subs.findCue(pm.cues, 500), -1);
  assert.equal(Subs.findCue(pm.cues, 9000), -1);
});
t('sameLang', () => {
  assert.ok(Subs.sameLang('zh-Hans', 'zh-CN'));
  assert.ok(!Subs.sameLang('zh-Hant', 'zh-CN'));
  assert.ok(Subs.sameLang('en-US', 'en'));
  assert.ok(!Subs.sameLang('en', 'zh-CN'));
});
console.log(`\n全部 ${n} 项通过`);
