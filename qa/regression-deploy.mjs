import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yixu-deploy-'));
try {
 const r=spawnSync('python3',['deploy/render.py','--output',dir,'--web-root','/srv/wardrobe/current/public','--backend-root','/srv/tryon/current','--data-root','/var/lib/wardrobe','--runtime-env','/etc/wardrobe/runtime.env','--api-port','8765'],{cwd:root,encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,'deployment renderer must succeed: '+r.stderr);
 const site=fs.readFileSync(path.join(dir,'site.conf'),'utf8');const admin=fs.readFileSync(path.join(dir,'admin.conf'),'utf8');
 assert.match(site,/root \/srv\/wardrobe\/current\/public;/);assert.match(site,/location \^~ \/api\/admin\/ \{ return 404; \}/);
 assert.match(site,/proxy_pass http:\/\/127\.0\.0\.1:8765;/);assert.match(site,/proxy_set_header X-Forwarded-For \$remote_addr;/);
 assert.match(admin,/server_name admin\.8882088\.xyz;/);assert.match(admin,/root \/srv\/tryon\/current\/admin;/);assert.match(admin,/live\/admin\.8882088\.xyz\/fullchain.pem/);
 assert.match(admin,/location ~ \\.mjs\$ \{ default_type text\/javascript;/);
 assert.doesNotMatch(site+admin,/limit_req|limit_conn|@@/);
 const api=fs.readFileSync(path.join(dir,'yixu-api.service'),'utf8');assert.match(api,/backend\.app:create_app --factory --host 127\.0\.0\.1/);assert.match(api,/ReadWritePaths=\/var\/lib\/wardrobe/);
 const worker=fs.readFileSync(path.join(dir,'yixu-worker.service'),'utf8');assert.match(worker,/-m backend\.worker/);assert.match(worker,/User=yixu/);
 const egress=fs.readFileSync(path.join(dir,'yixu-egress.service'),'utf8');assert.match(egress,/User=yixu-egress/);assert.match(egress,/ExecStart=\/usr\/local\/lib\/yixu-egress\/mihomo/);assert.match(egress,/NoNewPrivileges=true/);
 console.log('PASS deployment renders isolated public/admin TLS routes and loopback application units without rate quotas');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
