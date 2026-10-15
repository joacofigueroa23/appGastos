
import {spawnSync} from 'node:child_process';
const build=spawnSync(process.execPath,['--import','tsx','node_modules/vite/bin/vite.js','build','--outDir','dist-demo'],{windowsHide:true,stdio:'inherit',env:{...process.env,VITE_ENABLE_DEMO:'true'}});
if(build.status!==0)process.exit(build.status||1);
const result=spawnSync(process.execPath,['--test','tests/manual-browser.test.mjs'],{windowsHide:true,stdio:'inherit'});
process.exit(result.status||0);
