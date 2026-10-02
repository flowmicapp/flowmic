// Named, opt-in reverse control against an EXPORTED build only. Never edits a
// source checkout. Always restores bytes in finally, then runs the same scenario.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { liveEnabled } from './emb13-live-rig-lib.mjs';
if (!liveEnabled(process.env)) { console.log('SKIP: FLOWMIC_EMB13_LIVE is not 1; reverse controls spend managed transcription minutes.'); process.exit(2); }
const name = process.argv[2];
const plans = {
  toggle: { scenario: 'toggle', check: 'toggle', append: `
    (()=>{let seen=0;const d=Object.getOwnPropertyDescriptor(WebSocket.prototype,'onmessage');Object.defineProperty(WebSocket.prototype,'onmessage',{...d,set(fn){d.set.call(this,function(e){if(typeof e.data==='string'&&e.data.includes('"inject:request"')&&++seen>1)return;fn.call(this,e)})}})})();` },
  'tap-hold': { scenario: 'gestures', check: 'quick-double-tap', append: `
    (()=>{let seen=0,last='';setInterval(()=>{const root=document.querySelector('[data-flowmic-demo="voice"]')?.shadowRoot;const cap=root?.querySelector('[data-flowmic-mic="capsule"]');if(!cap)return;const voice=cap.dataset.voice;if(voice==='listening'&&last!==voice)seen++;last=voice;if(seen>=2){const error=root.querySelector('[data-flowmic-mic="error"]');error.textContent='WV7 stale recognition error';error.hidden=false;root.querySelector('[data-flowmic-mic="root"]').hidden=false;}},5)})();` },
  escape: { scenario: 'escape', check: 'escape', replace: ['"Escape"', '"WV7DisabledEscape"'] },
  quiet: { scenario: 'quiet', check: '1280-light', replace: ['.say("voiceCantHearYou")', '.say("embedListening")'] },
  finishing: { scenario: 'finishing', check: 'finishing', replace: ['.say("voiceStillFinishing")', '.say("embedFinishing")'] },
  placement: { scenario: 'placement', check: 'below', append: `
    (()=>{let added=false;setInterval(()=>{const root=document.querySelector('[data-flowmic-demo="voice"]')?.shadowRoot;const cap=root?.querySelector('[data-flowmic-mic="capsule"]');if(!cap)return;if(cap.dataset.voice==='added')added=true;if(added&&cap.dataset.voice==='listening'){cap.style.setProperty('transform','translateY(-64px)','important');cap.style.pointerEvents='auto';}},5)})();` },
  keyboard: { scenario: 'keyboard', check: 'hostKeysStayWithHost', append: `
    document.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.matches('textarea'))document.querySelector('.hti-press')?.click();});` },
  Space: { scenario: 'keyboard', check: 'Space', append: `document.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.closest('.hti-press')){e.stopImmediatePropagation();e.preventDefault()}},true);` },
  Enter: { scenario: 'keyboard', check: 'Enter', append: `document.addEventListener('keydown',e=>{if(e.code==='Enter'&&e.target.closest('.hti-press')){e.stopImmediatePropagation();e.preventDefault()}},true);` },
  cls: { scenario: 'budget', check: 'cls', append: `
    (()=>{let done=false;setInterval(()=>{const cap=document.querySelector('[data-flowmic-demo="voice"]')?.shadowRoot?.querySelector('[data-flowmic-mic="capsule"]');if(!done&&cap?.dataset.voice==='listening'){done=true;setTimeout(()=>{document.querySelector('.hero-try-wrap').style.marginTop='60px'},1500);}},20)})();` },
  stopToField: { scenario: 'budget', check: 'stopToField', append: `
    (()=>{const d=Object.getOwnPropertyDescriptor(WebSocket.prototype,'onmessage');Object.defineProperty(WebSocket.prototype,'onmessage',{...d,set(fn){d.set.call(this,function(e){if(typeof e.data==='string'&&e.data.includes('"stt:final"'))setTimeout(()=>fn.call(this,e),2200);else fn.call(this,e)})}})})();` },
  liveWord: { scenario: 'budget', check: 'liveWord', append: `
    (()=>{const d=Object.getOwnPropertyDescriptor(WebSocket.prototype,'onmessage');Object.defineProperty(WebSocket.prototype,'onmessage',{...d,set(fn){d.set.call(this,function(e){if(typeof e.data==='string'&&e.data.includes('"stt:interim"'))setTimeout(()=>fn.call(this,e),2600);else fn.call(this,e)})}})})();` },
  coldListening: { scenario: 'budget', check: 'coldListening', append: `
    (()=>{const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=c=>gum(c).then(s=>new Promise(r=>setTimeout(()=>r(s),1700)))})();` },
  warmListening: { scenario: 'budget', check: 'warmListening', append: `
    document.addEventListener('click',e=>{if(e.isTrusted&&e.target.closest('.hti-press')){e.stopImmediatePropagation();e.preventDefault();const target=e.target;setTimeout(()=>target.dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true})),1200)}},true);` },
  reaction: { scenario: 'budget', check: 'reaction', append: `
    for(const type of ['click'])document.addEventListener(type,e=>{if(e.isTrusted&&e.target.closest('.hti-press')){e.stopImmediatePropagation();e.preventDefault();const target=e.target;setTimeout(()=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,composed:true})),380)}},true);` },
};
const plan = plans[name]; if (!plan) throw new Error(`name a scenario: ${Object.keys(plans).join(', ')}`);
const web = realpathSync(process.env.FLOWMIC_EMB13_WEB_ROOT);
// Require the archive marker produced by this task, not just a plausible name.
if (!web.replaceAll('\\', '/').toLowerCase().includes('/_dispatch/tmp-wv7/') || existsSync(join(web, '.git')) || !existsSync(resolve(web, '../web.tar'))) throw new Error('reverse control requires the tmp-wv7 archive export');
const dist = join(web, 'apps/demo-card/dist');
const manifest = JSON.parse(readFileSync(join(dist, 'demo-card.heavy.json')));
const file = join(dist, manifest.file);
const original = readFileSync(file), sha = (b) => createHash('sha256').update(b).digest('hex');
let mutant = original.toString();
if (plan.replace) {
  if (!mutant.includes(plan.replace[0])) throw new Error(`mutation target absent: ${plan.replace[0]}`);
  mutant = mutant.split(plan.replace[0]).join(plan.replace[1]);
} else mutant += plan.append;
const out = resolve(process.env.FLOWMIC_EMB13_WV7_OUT, name, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`); mkdirSync(out, { recursive: true });
const run = (phase) => new Promise((ok, fail) => {
  const args = ['scripts/emb13-live-rig.mjs', `--wv7-scenario=${plan.scenario}`, `--wv7-check=${plan.check}`];
  const child = spawn(process.execPath, args, { env: { ...process.env, FLOWMIC_EMB13_WV7: '1', FLOWMIC_EMB13_RUNS: '1', FLOWMIC_EMB13_SENTENCES: '2', FLOWMIC_EMB13_WV7_SURFACES: 'home', FLOWMIC_EMB13_WV7_OUT: join(out, phase) }, windowsHide: true });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; }); child.on('error', fail);
  child.on('exit', (code) => { writeFileSync(join(out, `${phase}.log`), log); ok({ code, command: `node ${args.join(' ')}` }); });
});
let red;
try { writeFileSync(file, mutant); red = await run('red'); }
finally { writeFileSync(file, original); }
const restoredSha256 = sha(readFileSync(file));
if (restoredSha256 !== sha(original)) throw new Error('restoration hash mismatch');
const green = await run('green');
const reading = (phase) => {
  const runs = readdirSync(join(out, phase)).filter((name) => existsSync(join(out, phase, name, 'report.json')));
  if (runs.length !== 1) throw new Error('reverse receipt requires exactly one retained child run');
  const r = JSON.parse(readFileSync(join(out, phase, runs[0], 'report.json')));
  return r.results[0]?.checks?.[plan.check] ?? r.budgets?.home?.[plan.check]?.verdict ?? 'not measured';
};
const receipt = { name, file, beforeSha256: sha(original), restoredSha256, red: { ...red, reading: reading('red') }, green: { ...green, reading: reading('green') }, pass: red.code !== 0 && green.code === 0 && reading('red') === 'FAIL' && reading('green') === 'PASS' };
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
process.exitCode = receipt.pass ? 0 : 1;
