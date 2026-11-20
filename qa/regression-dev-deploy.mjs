import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const source=read('deploy/dev-release.py');
const site=read('deploy/dev-site.conf');
assert.match(source,/runuser.*USER/);
assert.match(source,/actions\/workflows\/check\.yml\/runs/);
assert.match(source,/latest\.get\(["']conclusion["']\) == ["']success["']/);
assert.match(site,/server_name dev-yixu\.8882088\.xyz;/);
assert.match(site,/location \^~ \/admin\//);
assert.match(site,/proxy_pass http:\/\/127\.0\.0\.1:8766;/);
assert.match(site,/X-Forwarded-For \$remote_addr/);
assert.doesNotMatch(site,/admin-dev\.|admin\.8882088|proxy_pass.*:8765/);
assert.match(read('deploy/dev-api.service'),/User=yixu-dev/);
assert.match(read('deploy/dev-api.service'),/ReadWritePaths=\/var\/lib\/yixu-wardrobe-dev/);
assert.match(read('deploy/dev-deploy.timer'),/OnUnitInactiveSec=60s/);

const python=String.raw`
import importlib.util,json,os,pathlib,pwd,subprocess,sys,tempfile,urllib.error
spec=importlib.util.spec_from_file_location('deployment',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
real_verify=m.verify
real_recheck=m.recheck_candidate
sha='a'*40;old='b'*40
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary)/'dev';state=pathlib.Path(temporary)/'private';root.mkdir();state.mkdir();(root/'releases').mkdir();(root/'repository.git').mkdir();(root/'repository.git'/'HEAD').write_text('ref: refs/heads/dev')
 m.ROOT=root;m.STATE=state;m.DATA=state/"appdata";m.USER=pwd.getpwuid(os.getuid()).pw_name;m.run=lambda args,**kw:sha if 'rev-parse' in args else '';m.time.sleep=lambda _:None
 old_release=root/'releases'/old;old_release.mkdir();m.switch_current(old_release)
 sentinel=state/'state.sqlite3';sentinel.write_bytes(b'private visitor state must survive rollback')
 calls=[];m.restart=lambda:calls.append('restart');m.ci_succeeded=lambda _:False
 m.build=lambda _:(_ for _ in ()).throw(AssertionError('CI must gate build'))
 m.deliver('http://127.0.0.1');assert (root/'current').resolve()==old_release;assert not calls
 m.ci_succeeded=lambda _:True
 def build(_):
  candidate=root/'releases'/sha;candidate.mkdir(exist_ok=True);return candidate
 m.build=build;m.verify=lambda *_:(_ for _ in ()).throw(RuntimeError('stale admin asset'))
 try:m.deliver('http://127.0.0.1')
 except RuntimeError:pass
 else:raise AssertionError('failed verification must fail delivery')
 assert (root/'current').resolve()==old_release;assert calls==['restart','restart']
 failure=json.loads((state/'deployment.json').read_text());assert failure['status']=='failed';assert failure['previous_release_restored'];assert failure['private_database_rolled_back'] is False
 assert sentinel.read_bytes()==b'private visitor state must survive rollback'
 m.build=lambda _:(_ for _ in ()).throw(AssertionError('unchanged failed SHA must not loop'))
 m.deliver('http://127.0.0.1')
 m.build=build;m.recheck_candidate=build;m.verify=lambda *_:{'revision':'catalog-version','featured_look_id':103,'source_sha256':'c'*64,'source_bytes':99,'source_verified':True,'static_verified':True}
 m.deliver('http://127.0.0.1',retry=True)
 assert (root/'current').resolve()==root/'releases'/sha
 receipt=json.loads((state/'deployment.json').read_text());assert receipt['status']=='verified';assert receipt['git_head']==sha
 try:m.switch_current(pathlib.Path('/srv/yixu-wardrobe/current'))
 except ValueError:pass
 else:raise AssertionError('production paths must never be selected')
 # Exercise real HTTP verification against byte fixtures, including administrator auth.
 release=root/'releases'/sha;(release/'public').mkdir();(release/'admin').mkdir()
 image=b'public image bytes';catalog={'revision':'catalog-version','home':{'featured_look_id':103},'looks':[{'id':103,'source_url':'/api/content/assets/look103','versions':{'v2':{'asset':{'bytes':len(image),'sha256':m.hashlib.sha256(image).hexdigest()}}}}]}
 snapshot='window.WARDROBE = '+json.dumps(catalog)+';\n';(release/'public/catalog.js').write_text(snapshot)
 routes={'/api/health':json.dumps({'ok':True,'provider_configured':False}).encode(),'/api/content/catalog':json.dumps(catalog).encode(),'/api/content/assets/look103':image}
 for name in ['index.html','app.js','style.css','expressive.css','tryon.js','tryon.css','product-themes.js','product-page.js','product-themes.css','favicon.svg']:
  data=('checked file '+name).encode();(release/'public'/name).write_bytes(data);routes['/' if name=='index.html' else '/'+name]=data
 routes['/catalog.js']=snapshot.encode()
 for name in ['index.html','app.mjs','admin.css']:
  data=('admin file '+name).encode();(release/'admin'/name).write_bytes(data);routes['/admin/'+name]=data
 def get(url,host=None):
  path=m.urllib.parse.urlsplit(url).path
  if path=='/api/admin/overview':raise urllib.error.HTTPError(url,401,'login required',None,None)
  return routes[path]
 m.get=get;m.verify=real_verify
 assert m.verify(release,'http://127.0.0.1')['static_files_verified']==14
 routes['/admin/app.mjs']=b'stale admin source'
 try:m.verify(release,'http://127.0.0.1')
 except RuntimeError as error:assert 'stale' in str(error)
 else:raise AssertionError('stale administrator code must fail delivery')
 # Real filesystem check: fix private build staging modes only below web roots.
 release.chmod(0o700)
 m.run=lambda args,**kw:subprocess.check_output(list(map(str,args)),text=True).strip()
 protected=state/'private-record';protected.write_bytes(b'private');protected.chmod(0o600)
 for name in ('public','admin'):
  (release/name).chmod(0o700)
  for file in (release/name).iterdir():file.chmod(0o600)
 m.make_web_readable(release)
 assert release.stat().st_mode&0o777==0o755
 for name in ('public','admin'):
  assert (release/name).stat().st_mode&0o777==0o755
  assert all(file.stat().st_mode&0o777==0o644 for file in (release/name).iterdir())
 assert protected.stat().st_mode&0o777==0o600
 (release/'public'/'unsafe-link').symlink_to(protected)
 try:m.make_web_readable(release)
 except RuntimeError:pass
 else:raise AssertionError('web-root links must not broaden private permissions')
 assert protected.stat().st_mode&0o777==0o600
 (release/'public'/'unsafe-link').unlink()
 tracked=release/'tracked.txt';tracked.write_bytes(b'approved git bytes')
 blob=m.hashlib.sha1(b'blob 18\0approved git bytes',usedforsecurity=False).hexdigest()
 def commands(args,**kw):
  if 'ls-tree' in args:return '100644 blob '+blob+'\ttracked.txt'
  if '-e' in args:return 'catalog-version'
  return ''
 m.run=commands
 assert real_recheck(sha)==release
 tracked.write_bytes(b'altered candidate source')
 try:real_recheck(sha)
 except RuntimeError as error:assert 'differs' in str(error)
 else:raise AssertionError('reviewed retry must reject altered source without deleting current release')
 assert (root/'current').resolve()==release
print('PASS dev deployment CI gate, isolated activation, auth/static integrity, rollback, persistent data, web-root-only modes and failed-SHA no-retry')
`;
const result=spawnSync('python3',['-c',python,root+'deploy/dev-release.py'],{encoding:'utf8',timeout:10000});
assert.equal(result.status,0,result.stderr||result.stdout);
console.log(result.stdout.trim());
console.log('PASS isolated dev service, same-origin administrator, TLS template and timer contract');
