const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DOWNLOAD_DIR = './downloads';
const COOKIE_FILE = './tiktok_session.json';
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

let prefix = '.';
let sessionCookies = '';
let sessionReady = false;
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

async function initSession() {
  console.log('🔄 Initializing TikTok session...');
  
  // Try saved cookies
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      sessionCookies = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      const test = await axios.get('https://www.tiktok.com/', {
        headers: { 'User-Agent': UA, 'Cookie': sessionCookies },
        timeout: 8000
      });
      if (test.status === 200 && !test.data.includes('captcha')) {
        console.log('✅ Using saved session');
        sessionReady = true;
        return;
      }
    } catch(e) {}
  }

  // Try Puppeteer for fresh session
  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXEC_PATH || null,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const pg = await browser.newPage();
    await pg.setUserAgent(UA);
    await pg.goto('https://www.tiktok.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pg.waitForTimeout(2000);
    const cookies = await pg.cookies();
    sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    fs.writeFileSync(COOKIE_FILE, sessionCookies);
    await browser.close();
    console.log('✅ Session ready');
    sessionReady = true;
  } catch (e) {
    console.log('⚠️ No Puppeteer session. Some features may be limited.');
  }
}

async function fetchPage(url) {
  if (sessionCookies) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Cookie': sessionCookies, 'Accept': 'text/html' },
        timeout: 15000
      });
      return res.data;
    } catch(e) {}
  }
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    return res.data;
  } catch(e) { return { error: e.message }; }
}

async function fetchAPI(url) {
  if (!sessionCookies) return [];
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Cookie': sessionCookies, 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://www.tiktok.com/' },
      timeout: 10000
    });
    return res.data;
  } catch(e) { return []; }
}

// Regex scrapers
function $x(html, key) { const m = html.match(new RegExp(`"${key}":"?([^"}\\s,]+)"?`)); return m ? m[1].replace(/\\u002F/g,'/').replace(/\\"/g,'"') : null; }
function $n(html, key) { const m = html.match(new RegExp(`"${key}":(\\d+)`)); return m ? parseInt(m[1]) : 0; }

async function getProfile(username) {
  const clean = username.replace('@', '');
  const html = await fetchPage(`https://www.tiktok.com/@${clean}`);
  if (html.error || typeof html !== 'string') return null;
  return {
    username: $x(html, 'uniqueId') || clean,
    nickname: $x(html, 'nickname') || clean,
    bio: (html.match(/"signature":"([^"]+)"/)||[,''])[1].replace(/\\n/g,' ') || '',
    followers: $n(html, 'followerCount'),
    following: $n(html, 'followingCount'),
    likes: $n(html, 'heartCount'),
    videos: $n(html, 'videoCount'),
    verified: html.includes('"verified":true')
  };
}

async function getVideoInfo(url) {
  let target = url;
  if (url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) {
    try { const r = await axios.get(url, { headers: { 'User-Agent': UA }, maxRedirects: 5, timeout: 10000 }); target = r.request.res.responseUrl || url; } catch(e) {}
  }
  const html = await fetchPage(target);
  if (html.error || typeof html !== 'string') return null;
  const vUrl = $x(html, 'playAddr') || '';
  return {
    id: $x(html, 'id'),
    desc: (html.match(/"desc":"([^"]+)"/)||[,''])[1] || '',
    author: $x(html, 'uniqueId') || '',
    likes: $n(html, 'diggCount'),
    comments: $n(html, 'commentCount'),
    shares: $n(html, 'shareCount'),
    views: $n(html, 'playCount'),
    duration: $n(html, 'duration'),
    videoUrl: vUrl.replace(/\["/,'').replace(/"\].*/,''),
    cover: $x(html, 'cover') || ''
  };
}

async function searchVideos(query, count = 8) {
  const d = await fetchAPI(`https://www.tiktok.com/api/search/item/full/?count=${count}&keyword=${encodeURIComponent(query)}&language=en`);
  if (d && d.itemList) return d.itemList.slice(0,count).map(v => ({ desc: (v.desc||'').substring(0,60), author: v.author?.uniqueId||'', likes: (v.stats||{}).diggCount||0 }));
  return [];
}

async function trending() {
  const d = await fetchAPI('https://www.tiktok.com/api/recommend/item/list/?count=10&language=en');
  if (d && d.itemList) return d.itemList.slice(0,10).map(v => ({ desc: (v.desc||'').substring(0,60), author: v.author?.uniqueId||'', likes: (v.stats||{}).diggCount||0 }));
  return [];
}

async function getUserVideos(username, count = 10) {
  const clean = username.replace('@', '');
  const d = await fetchAPI(`https://www.tiktok.com/api/post/item/list/?uniqueId=${clean}&count=${count}&language=en`);
  if (d && d.itemList) return d.itemList.slice(0,count).map(v => ({ desc: (v.desc||'').substring(0,50), likes: (v.stats||{}).diggCount||0 }));
  return [];
}

async function getComments(url) {
  const m = url.match(/video\/(\d+)/);
  if (!m) return [];
  const d = await fetchAPI(`https://www.tiktok.com/api/comment/list/?awemeId=${m[1]}&count=10&language=en`);
  if (d && d.comments) return d.comments.map(c => ({ user: c.user?.uniqueId||'Anon', text: c.text||'', likes: c.diggCount||0 }));
  return [];
}

async function downloadVideo(url) {
  const info = await getVideoInfo(url);
  if (!info || !info.videoUrl) return { error: 'Could not get video URL' };
  const filename = `tiktok_${info.id||Date.now()}.mp4`;
  const filepath = path.join(DOWNLOAD_DIR, filename);
  try {
    const res = await axios({ method:'GET', url: info.videoUrl, responseType:'stream', timeout:60000, headers: { 'User-Agent': UA, 'Referer': 'https://www.tiktok.com/' } });
    const writer = fs.createWriteStream(filepath);
    res.data.pipe(writer);
    return new Promise(r => { writer.on('finish', ()=>r({path:filepath,filename,info})); writer.on('error', ()=>r({error:'Write failed'})); });
  } catch(e) { return { error: 'Download failed' }; }
}

// Format
const esc = s => s ? s.replace(/[\n\r]/g,' ').trim() : '';
const fn = n => (n||0).toLocaleString();

async function processCommand(input) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const text = args.join(' ');

  try {
    switch (cmd) {
      case `${prefix}menu`:
        return `📱 *TIKTOK BOT*\n\n${prefix}profile <@u> — Profile\n${prefix}video <url> — Video info\n${prefix}download <url> — Download\n${prefix}search <q> — Search\n${prefix}trending — Trending\n${prefix}user <@u> — User videos\n${prefix}comments <url> — Comments\n${prefix}about — Info`;

      case `${prefix}profile`:
        if (!text) return 'Usage: .profile @user';
        const p = await getProfile(text);
        return p ? `📱 @${p.username}\n👤 ${p.nickname}${p.verified?' ✅':''}\n📝 ${p.bio||'No bio'}\n👥 ${fn(p.followers)} · ➡️ ${fn(p.following)}\n❤️ ${fn(p.likes)} · 🎬 ${p.videos}` : `❌ Not found`;

      case `${prefix}video`:
        if (!text) return 'Usage: .video url';
        const v = await getVideoInfo(text);
        const dur = v?.duration ? `${Math.floor(v.duration/60)}:${String(v.duration%60).padStart(2,'0')}` : 'N/A';
        return v ? `🎬 ${v.desc||'No caption'}\n👤 @${v.author}\n❤️ ${fn(v.likes)} 💬 ${fn(v.comments)} 🔄 ${fn(v.shares)} 👁️ ${fn(v.views)}\n⏱️ ${dur}` : '❌ Could not fetch';

      case `${prefix}download`:
        if (!text) return 'Usage: .download url';
        const d = await downloadVideo(text);
        return d.error ? `❌ ${d.error}` : `✅ Saved: ${d.filename}`;

      case `${prefix}search`:
        if (!text) return 'Usage: .search query';
        const sr = await searchVideos(text);
        return sr.length ? sr.map((v,i)=>`${i+1}. ${esc(v.desc)}\n   @${v.author} ❤️ ${fn(v.likes)}`).join('\n\n') : 'No results';

      case `${prefix}trending`:
        const tr = await trending();
        return tr.length ? tr.map((v,i)=>`${i+1}. ${esc(v.desc)}\n   @${v.author} ❤️ ${fn(v.likes)}`).join('\n\n') : 'No trending';

      case `${prefix}user`:
        if (!text) return 'Usage: .user @username';
        const uv = await getUserVideos(text);
        return uv.length ? uv.map((v,i)=>`${i+1}. ${esc(v.desc)}\n   ❤️ ${fn(v.likes)}`).join('\n\n') : 'No videos';

      case `${prefix}comments`:
        if (!text) return 'Usage: .comments url';
        const cm = await getComments(text);
        return cm.length ? cm.map((c,i)=>`${i+1}. @${c.user}: ${esc(c.text).substring(0,70)}\n   ❤️ ${c.likes}`).join('\n\n') : 'No comments';

      case `${prefix}about`:
        return `🤖 TikTok Bot v4\nProfile/video/download: works without login\nSearch/trending/comments: needs browser session\nRun again to auto-init session.`;

      default: return '';
    }
  } catch(e) { return '❌ ' + e.message; }
}

module.exports = { processCommand, initSession, getProfile, getVideoInfo, searchVideos, trending, getUserVideos, getComments, downloadVideo };

// CLI mode
if (require.main === module) {
  (async () => {
    await initSession();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    console.log('\n📱 TikTok Bot ready! Type .menu\n');
    rl.prompt();
    rl.on('line', async line => {
      const input = line.trim();
      if (!input) { rl.prompt(); return; }
      if (input === '.exit' || input === '.quit') { console.log('👋 Bye!'); rl.close(); return; }
      const reply = await processCommand(input);
      if (reply) console.log('\n' + reply + '\n');
      rl.prompt();
    });
  })();
}
