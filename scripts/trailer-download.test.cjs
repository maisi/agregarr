/* eslint-disable @typescript-eslint/no-var-requires, no-console */
// Run with Node 20+: node --test scripts/trailer-download.test.cjs
// TypeScript is already a dev dependency. The override permits a pre-install RED run.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require(process.env.TRAILER_TEST_TYPESCRIPT || 'typescript');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(
  root,
  'server/lib/placeholders/trailerDownload.ts'
);
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText;
const videoId = 'aB_12-cD345';
const metadata = (entries = [{ id: videoId, title: 'Official trailer' }]) =>
  JSON.stringify({ entries });
const downloaded = Buffer.from('fixture: downloaded trailer');
const cookieContents = 'TEST_ONLY_COOKIE_PAYLOAD';

// Only external boundaries are supplied: process spawn, log output, configuration
// input. The real public function makes every search/cache/fallback decision and
// uses real files, including the repository's bundled placeholder.
async function fixture(t, scenario = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailer-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public/assets'), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'public/assets/placeholder.mp4'),
    path.join(dir, 'public/assets/placeholder.mp4')
  );
  fs.writeFileSync(
    path.join(dir, 'config/settings.json'),
    JSON.stringify({
      main: { skipYoutubeTrailerDownloads: !!scenario.disabled },
    })
  );
  if (scenario.cookies) {
    fs.writeFileSync(
      path.join(dir, 'config/youtube-cookies.txt'),
      cookieContents
    );
  }
  const calls = [];
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push([level, ...args]),
    ])
  );
  function spawn(command, args, options) {
    calls.push({ command, args, options });
    assert.equal(command, 'yt-dlp');
    assert.notEqual(options?.shell, true, 'never execute a shell');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      return true;
    };
    const isSearch = args.some((arg) => arg.startsWith('ytsearch'));
    process.nextTick(() => {
      const error = isSearch ? scenario.searchError : scenario.downloadError;
      if (error) {
        child.emit('error', new Error(error));
        child.emit('close', -2);
        return;
      }
      if (isSearch) {
        const stdout = scenario.stdout ?? metadata();
        // Exercise stream accumulation instead of assuming one data event.
        const halfway = Math.floor(stdout.length / 2);
        child.stdout.write(stdout.slice(0, halfway));
        child.stdout.end(stdout.slice(halfway));
        child.stderr.end(scenario.stderr || '');
        child.emit(
          'close',
          Object.hasOwn(scenario, 'searchExit') ? scenario.searchExit : 0
        );
      } else {
        child.stdout.end(scenario.downloadStdout || '');
        child.stderr.end(scenario.downloadStderr || '');
        if (!scenario.downloadExit) {
          fs.writeFileSync(args[args.indexOf('-o') + 1], downloaded);
        }
        child.emit('close', scenario.downloadExit ?? 0);
      }
    });
    return child;
  }
  const exports = {};
  const boundaryRequire = (id) => {
    if (id === 'child_process') return { spawn };
    if (id === '@server/logger') return logger;
    if (id === '@server/lib/settings') {
      return {
        getSettings: () =>
          JSON.parse(fs.readFileSync(path.join(dir, 'config/settings.json'))),
      };
    }
    return require(id);
  };
  const load = vm.runInThisContext(
    `(function(require, exports, process, __filename, __dirname) {${compiled}\n})`,
    { filename: sourcePath }
  );
  load(
    boundaryRequire,
    exports,
    { cwd: () => dir },
    sourcePath,
    path.dirname(sourcePath)
  );
  return { ...exports, dir, calls, logs };
}

async function assertPlaceholder(f, title = 'Fallback') {
  const output = await f.downloadTrailer(title, 2026);
  assert.deepEqual(
    fs.readFileSync(output),
    fs.readFileSync(path.join(root, 'public/assets/placeholder.mp4'))
  );
  return output;
}

for (const year of [2026, undefined]) {
  test(`public download searches title${
    year ? ' and year' : ' without year'
  }`, async (t) => {
    const f = await fixture(t);
    const output = await f.downloadTrailer('Some Film', year, 'movie');
    assert.ok(
      fs.readFileSync(output).equals(downloaded),
      'expected downloaded trailer, got fallback'
    );
    assert.equal(f.calls.length, 2, 'one search followed by one download');
    const [search, download] = f.calls;
    assert.equal(
      search.args.at(-1),
      `ytsearch1:Some Film${year ? ` ${year}` : ''} official trailer`
    );
    assert.ok(search.args.includes('--dump-single-json'));
    assert.ok(search.args.includes('--flat-playlist'));
    assert.ok(search.args.includes('--skip-download'));
    assert.equal(search.args.at(-2), '--');
    assert.equal(
      download.args.at(-1),
      `https://www.youtube.com/watch?v=${videoId}`
    );
    assert.equal(
      download.args[download.args.indexOf('--match-filter') + 1],
      'duration < 210'
    );
    assert.ok(download.args.includes('--break-on-reject'));
    assert.equal(
      download.args[download.args.indexOf('--merge-output-format') + 1],
      'mp4'
    );
    assert.match(
      download.args[download.args.indexOf('-f') + 1],
      /height<=1080/
    );
    assert.ok(!search.args.includes('--cookies'));
    assert.ok(!download.args.includes('--cookies'));
    assert.ok(JSON.stringify(f.logs).includes('Official trailer'));
    assert.ok(!JSON.stringify(f.logs).includes('official trailer'));
    // A cached trailer avoids even a second search.
    assert.equal(await f.downloadTrailer('Some Film', year), output);
    assert.equal(f.calls.length, 2);
  });
}

test('shell metacharacters remain a single argv value; cookies reach both calls', async (t) => {
  const f = await fixture(t, { cookies: true });
  const title = '-Film; $(touch INJECTED) `touch INJECTED` & | > " \' \n';
  const output = await f.downloadTrailer(title, undefined, 'tv');
  assert.ok(
    fs.readFileSync(output).equals(downloaded),
    'expected downloaded trailer, got fallback'
  );
  assert.equal(f.calls[0].args.at(-1), `ytsearch1:${title} official trailer`);
  for (const call of f.calls) {
    assert.notEqual(call.options?.shell, true);
    assert.equal(call.args.filter((arg) => arg === '--cookies').length, 1);
    assert.equal(
      call.args[call.args.indexOf('--cookies') + 1],
      path.join(f.dir, 'config/youtube-cookies.txt')
    );
  }
  assert.equal(fs.existsSync(path.join(f.dir, 'INJECTED')), false);
  assert.ok(!JSON.stringify(f.logs).includes(cookieContents));
});

for (const [label, stdout] of [
  ['empty results', metadata([])],
  ['empty output', ''],
  ['malformed JSON', '{bad SEARCH_PAYLOAD'],
  ['null JSON', 'null'],
  ['missing entries', '{}'],
  ['invalid entries', '{"entries":{}}'],
  ['null entry', metadata([null])],
  ['missing id', metadata([{ title: 'Trailer' }])],
  ['unsafe id', metadata([{ id: '../;touch INJECTED', title: 'Trailer' }])],
  ['non-string id', metadata([{ id: 123, title: 'Trailer' }])],
  ['missing title', metadata([{ id: videoId }])],
  ['non-string title', metadata([{ id: videoId, title: {} }])],
  ['blank title', metadata([{ id: videoId, title: '  ' }])],
]) {
  test(`${label} copies the bundled placeholder without downloading`, async (t) => {
    const f = await fixture(t, { stdout });
    await assertPlaceholder(f);
    assert.equal(f.calls.length, 1, 'only the search process runs');
    assert.ok(!JSON.stringify(f.logs).includes('SEARCH_PAYLOAD'));
  });
}

for (const [label, scenario] of [
  [
    'search nonzero exit',
    { searchExit: 1, stderr: 'SEARCH_PAYLOAD TEST_ONLY_COOKIE_PAYLOAD' },
  ],
  ['search signal exit', { searchExit: null }],
  [
    'search process error',
    { searchError: 'SEARCH_PAYLOAD TEST_ONLY_COOKIE_PAYLOAD' },
  ],
]) {
  test(`${label} falls back without logging process payloads`, async (t) => {
    const f = await fixture(t, scenario);
    await assertPlaceholder(f);
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(f.logs).includes('SEARCH_PAYLOAD'));
    assert.ok(!JSON.stringify(f.logs).includes(cookieContents));
  });
}

for (const [label, scenario] of [
  [
    'duration rejection',
    {
      downloadExit: 101,
      downloadStdout: '[download] Trailer does not pass filter',
    },
  ],
  [
    'download failure',
    {
      downloadExit: 1,
      downloadStdout: 'SEARCH_PAYLOAD',
      downloadStderr: cookieContents,
    },
  ],
  ['download spawn error', { downloadError: cookieContents }],
]) {
  test(`${label} retains cookies and falls back safely`, async (t) => {
    const f = await fixture(t, { ...scenario, cookies: true });
    await assertPlaceholder(f);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[1].args.includes('--cookies'));
    assert.ok(!JSON.stringify(f.logs).includes(cookieContents));
    assert.ok(!JSON.stringify(f.logs).includes('SEARCH_PAYLOAD'));
    if (scenario.downloadExit === 101) {
      assert.ok(
        f.logs.some(
          ([level, msg]) => level === 'info' && msg.includes('too long')
        )
      );
    }
  });
}

test('disabled downloads copy the placeholder through the public settings path', async (t) => {
  const f = await fixture(t, { disabled: true });
  await assertPlaceholder(f);
  assert.equal(f.calls.length, 0);
});
