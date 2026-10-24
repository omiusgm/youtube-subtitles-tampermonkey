const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../youtube-subtitles.user.js');

test('JSON3 joins word segments, preserves Cyrillic and repeated speech, skips empty markers', () => {
  const result = c.parseCaptions({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Привет, ' }, { utf8: 'мир!' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Да' }] },
    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'Да' }] },
  ] });
  assert.deepEqual(result, [
    { start: 0, end: 1000, text: 'Привет, мир!' },
    { start: 2000, end: 3000, text: 'Да' }, { start: 3000, end: 4000, text: 'Да' },
  ]);
});

test('empty, malformed and unrelated responses never become empty downloadable files', () => {
  for (const body of ['', ' ', '<html>blocked</html>', '{broken', { error: {} }, { events: [] }]) assert.deepEqual(c.parseCaptions(body), []);
  assert.throws(() => c.format([], 'txt', {}), /Нет текста/);
});

test('VTT handles hours, settings, entities and inline word timestamps', () => {
  const text = 'WEBVTT\n\nNOTE source\nmetadata\n\n1\n01:02:03.004 --> 01:02:05.006 align:start\n<v Speaker>Привет &amp; мир<01:02:04.000>!\n\n00:06.000 --> 00:07.500\nСледующая строка\n';
  assert.deepEqual(c.parseCaptions(text), [
    { start: 6000, end: 7500, text: 'Следующая строка' },
    { start: 3723004, end: 3725006, text: 'Привет & мир!' },
  ]);
});

test('normalization preserves meaningful repeats, removes exact duplicates and infers missing ends', () => {
  assert.deepEqual(c.normalize([
    { start: 5000, text: 'последний' }, { start: 0, text: 'первый' },
    { start: 0, text: 'первый' }, { start: -10, text: 'ошибка' },
  ]), [{ start: 0, end: 5000, text: 'первый' }, { start: 5000, end: 7000, text: 'последний' }]);
});

test('SRT, VTT and TXT have correct delimiters, metadata and safe literal markup', () => {
  const cues = [{ start: 3723004, end: 3725006, text: 'Я <3 ИИ & мир' }];
  assert.equal(c.format(cues, 'srt', {}), '1\n01:02:03,004 --> 01:02:05,006\nЯ &lt;3 ИИ &amp; мир\n');
  assert.equal(c.format(cues, 'vtt', {}), 'WEBVTT\n\n01:02:03.004 --> 01:02:05.006\nЯ &lt;3 ИИ &amp; мир\n');
  const meta = { title: 'Тест', language: 'ru', url: 'https://www.youtube.com/watch?v=testVideo01' };
  assert.equal(c.format(cues, 'txt', meta), 'Тест\nhttps://www.youtube.com/watch?v=testVideo01\nЯзык: ru\n\nЯ <3 ИИ & мир\n');
  assert.match(c.format(cues, 'timed', meta), /\[01:02:03\] Я <3 ИИ & мир/);
});

test('millisecond rounding never emits 1000 milliseconds or drops hour digits', () => {
  assert.equal(c.stamp(59999.6), '00:01:00,000');
  assert.equal(c.stamp(360000000), '100:00:00,000');
  assert.equal(c.stamp(0, '.'), '00:00:00.000');
});

test('filenames survive Cyrillic, emoji, path separators and bidirectional overrides', () => {
  const file = c.filename('😀'.repeat(100) + '/\\:*?<>|\u202e', 'testVideo01', 'русский'.repeat(30), 'timed');
  assert.ok(Buffer.byteLength(file, 'utf8') < 255);
  assert.match(file, /\[testVideo01\].*\.txt$/);
  assert.doesNotMatch(file, /[/\\:*?<>|\u202e]/);
});

test('only actual HTTPS YouTube caption endpoints are accepted', () => {
  for (const url of ['https://evil.test/api/timedtext', 'https://youtube.com.evil.test/api/timedtext', 'http://www.youtube.com/api/timedtext', 'https://www.youtube.com/api/player', 'javascript:alert(1)']) assert.equal(c.captionUrl(url), null);
  assert.ok(c.captionUrl('https://www.youtube.com/api/timedtext?v=testVideo01&lang=ru'));
});

test('translations and authored/automatic caption tracks have separate identities', () => {
  const urls = ['', '&kind=asr', '&tlang=ru', '&name=alternative'].map(s => new URL('https://www.youtube.com/api/timedtext?lang=en' + s));
  assert.equal(new Set(urls.map(c.identity)).size, 4);
});

test('transcript response extracts selected language, timestamps and full contents', () => {
  const result = c.fromTranscript({ actions: [{ updateEngagementPanelAction: { content: {
    transcriptRenderer: { content: { transcriptSearchPanelRenderer: {
      body: { transcriptSegmentListRenderer: { initialSegments: [
        { transcriptSectionHeaderRenderer: { title: 'Глава' } },
        { transcriptSegmentRenderer: { startMs: '1000', endMs: '3200', snippet: { runs: [{ text: 'Первый ' }, { text: 'фрагмент' }] } } },
      ] } }, footer: { sortFilterSubMenuRenderer: { subMenuItems: [{ title: 'Русский', selected: true }, { title: 'English' }] } },
    } } },
  } } }] });
  assert.deepEqual(result, { cues: [{ start: 1000, end: 3200, text: 'Первый фрагмент' }], language: 'Русский', incomplete: false });
});

test('paginated transcripts are flagged, while language-switch commands are not', () => {
  assert.equal(c.fromTranscript({ initialSegments: [{ continuationItemRenderer: { continuationEndpoint: { token: 'next' } } }] }).incomplete, true);
  assert.equal(c.fromTranscript({ initialSegments: [], continuations: [{ nextContinuationData: {} }] }).incomplete, true);
  assert.equal(c.fromTranscript({ sortFilterSubMenuRenderer: { subMenuItems: [{ continuation: { reloadContinuationData: { continuation: 'language' } } }] } }).incomplete, false);
});

test('new transcript view models and absent duration are supported', () => {
  assert.deepEqual(c.fromTranscript({ items: [
    { transcriptSegmentViewModel: { startTimeMs: '0', text: { content: 'Начало' } } },
    { transcriptSegmentViewModel: { startTimeMs: '1500', text: { content: 'Конец' } } },
  ] }).cues, [{ start: 0, end: 1500, text: 'Начало' }, { start: 1500, end: 3500, text: 'Конец' }]);
});

test('large transcripts with missing end times normalize without quadratic copying', () => {
  const cues = c.normalize(Array.from({ length: 20000 }, (_, i) => ({ start: i * 1000, text: `строка ${i}` })));
  assert.equal(cues.length, 20000);
  assert.equal(cues[19999].end, 20001000);
});
