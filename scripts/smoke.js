const { execSync } = require('child_process');
const fs = require('fs');
const need = ['main.js','preload.js','renderer.js','index.html','overlay.html','package.json','assets/trayTemplate.png'];
let fail = 0;
for (const f of need) { if (!fs.existsSync(f)) { console.error('missing '+f); fail=1; } }
for (const f of ['main.js','preload.js','renderer.js']) {
  try { execSync(`node --check ${f}`, {stdio:'pipe'}); console.log('ok '+f); }
  catch(e){ console.error('syntax fail '+f); fail=1; }
}
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
for (const k of ['productName','version','build']) { if(!pkg[k]){console.error('pkg missing '+k); fail=1;} }
console.log(fail? 'SMOKE FAIL':'SMOKE PASS');
process.exit(fail);
