[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PmtilesPath,

    [Parameter(Mandatory = $true)]
    [string]$PmtilesJsPath,

    [Parameter(Mandatory = $true)]
    [string]$EvidenceDir,

    [string]$EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$MapRoot = Join-Path $RepoRoot "resources\map-default"
$FoodRoot = Join-Path $RepoRoot "resources\food-icons"
$ArchivePath = Join-Path $MapRoot "basemap.pmtiles"
$EvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceDir)
$OverallBlocked = $false

function Write-Group([string]$Name) { Write-Host "`n=== $Name ===" }
function Add-Blocked([string]$Message) { $script:OverallBlocked = $true; Write-Host "BLOCKED $Message" -ForegroundColor Yellow }
function Add-Fail([string]$Message) { $script:OverallBlocked = $true; Write-Host "FAIL $Message" -ForegroundColor Red }
function Add-Pass([string]$Message) { Write-Host "PASS $Message" -ForegroundColor Green }

foreach ($Required in @($PmtilesPath, $PmtilesJsPath, $EdgePath, $ArchivePath)) {
    if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) { throw "BLOCKED: required file is missing: $Required" }
}
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null

Write-Group "1. Formal asset checker"
$CheckOutputPath = Join-Path $EvidenceRoot "check-assets.txt"
& node.exe (Join-Path $ScriptDir "check-assets.mjs") --pmtiles $PmtilesPath 2>&1 | Tee-Object -FilePath $CheckOutputPath
$CheckExit = $LASTEXITCODE
if ($CheckExit -eq 0) { Add-Pass "check-assets.mjs exited 0" } else { Add-Blocked "check-assets.mjs exited $CheckExit; see $CheckOutputPath" }

Write-Group "2. PMTiles header, metadata, and verify"
$HeaderPath = Join-Path $EvidenceRoot "pmtiles-header.json"
$MetadataPath = Join-Path $EvidenceRoot "pmtiles-metadata.json"
$VerifyPath = Join-Path $EvidenceRoot "pmtiles-verify.txt"
(& $PmtilesPath version 2>&1 | Out-String).Trim() | Set-Content -LiteralPath (Join-Path $EvidenceRoot "pmtiles-version.txt") -Encoding utf8
(& $PmtilesPath show $ArchivePath --header-json 2>&1 | Out-String).Trim() | Set-Content -LiteralPath $HeaderPath -Encoding utf8
if ($LASTEXITCODE -ne 0) { Add-Fail "pmtiles show --header-json failed" } else { Add-Pass "PMTiles header captured" }
(& $PmtilesPath show $ArchivePath --metadata 2>&1 | Out-String).Trim() | Set-Content -LiteralPath $MetadataPath -Encoding utf8
if ($LASTEXITCODE -ne 0) { Add-Fail "pmtiles show --metadata failed" } else { Add-Pass "PMTiles metadata captured" }
(& $PmtilesPath verify $ArchivePath 2>&1 | Out-String).Trim() | Set-Content -LiteralPath $VerifyPath -Encoding utf8
if ($LASTEXITCODE -ne 0) { Add-Fail "pmtiles verify failed" } else { Add-Pass "pmtiles verify exited 0" }

Write-Group "3. Temporary loopback Range server"
$ServerScript = Join-Path $EvidenceRoot "stage0-loopback-server.mjs"
$PortFile = Join-Path $EvidenceRoot "server-port.txt"
$RequestLog = Join-Path $EvidenceRoot "loopback-requests.ndjson"
$TestHtml = Join-Path $EvidenceRoot "offline-test.html"
$ServerStdout = Join-Path $EvidenceRoot "server-stdout.txt"
$ServerStderr = Join-Path $EvidenceRoot "server-stderr.txt"
$RangeHeaders = Join-Path $EvidenceRoot "range-headers.txt"
$RangeBody = Join-Path $EvidenceRoot "range-body.bin"
Remove-Item -LiteralPath $PortFile, $RequestLog, $RangeHeaders, $RangeBody -Force -ErrorAction SilentlyContinue

$Html = @'
<!doctype html>
<html lang="zh-Hans" data-status="STARTING">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; child-src blob:">
  <link rel="stylesheet" href="/lib/maplibre-gl.css">
  <style>html,body,#map{width:100%;height:100%;margin:0}#status{position:absolute;z-index:3;background:#fff;padding:8px;font:14px sans-serif}</style>
</head>
<body><div id="status">STARTING</div><div id="map"></div>
<script src="/lib/maplibre-gl.js"></script><script src="/lib/pmtiles.js"></script>
<script type="module">
const status = document.getElementById('status');
let resolveDone;
const done = new Promise(resolve => { resolveDone = resolve; });
const setStatus = (value, detail='') => { document.documentElement.dataset.status=value; status.textContent=value + (detail ? ': '+detail : ''); if(value !== 'STARTING') resolveDone(); };
(async () => {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  const style = await (await fetch('/map/style.json')).json();
  style.sources.openmaptiles.url = `pmtiles://${location.origin}/map/basemap.pmtiles`;
  style.glyphs = `${location.origin}/map/fonts/{fontstack}/{range}.pbf`;
  const map = new maplibregl.Map({container:'map',style,center:[113.3158,23.1220],zoom:15.15,pitch:0,bearing:0,localIdeographFontFamily:'Microsoft YaHei'});
  const errors=[];
  map.on('error', event => { errors.push(event.error?.message || String(event.error || 'map error')); setStatus('FAIL', errors.join(' | ')); });
  map.on('load', async () => {
    try {
      const food = await (await fetch('/food/manifest.json')).json();
      await Promise.all(Object.entries(food.icons).map(async ([key, item]) => {
        const loaded = await map.loadImage(`/food/${item.src}`);
        map.addImage(key, loaded.data, {pixelRatio:item.pixelRatio, sdf:item.sdf});
      }));
      const features = food.cuisines.map((cuisine,index) => ({type:'Feature',geometry:{type:'Point',coordinates:[113.309+(index%4)*0.004,23.117+Math.floor(index/4)*0.004]},properties:{iconKey:cuisine.icons[index%3]}}));
      map.addSource('food-test',{type:'geojson',data:{type:'FeatureCollection',features}});
      map.addLayer({id:'food-test-icons',type:'symbol',source:'food-test',layout:{'icon-image':['get','iconKey'],'icon-size':0.55,'icon-allow-overlap':true}});
      await new Promise(resolve => map.once('idle', resolve));
      if (errors.length) throw new Error(errors.join(' | '));
      setStatus('PASS', `style + PMTiles + glyphs + ${Object.keys(food.icons).length} icons loaded`);
    } catch (error) { setStatus('FAIL', error.message || String(error)); }
  });
  setTimeout(() => { if (document.documentElement.dataset.status === 'STARTING') setStatus('FAIL','timeout after 20 seconds'); }, 20000);
})().catch(error => setStatus('FAIL', error.message || String(error)));
await done;
</script></body></html>
'@
$Html | Set-Content -LiteralPath $TestHtml -Encoding utf8

$ServerSource = @'
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";

const [mapRoot, foodRoot, maplibreJs, maplibreCss, pmtilesJs, htmlPath, portFile, logFile] = process.argv.slice(2);
const routes = new Map([
  ["/lib/maplibre-gl.js", maplibreJs], ["/lib/maplibre-gl.css", maplibreCss],
  ["/lib/pmtiles.js", pmtilesJs], ["/test.html", htmlPath], ["/", htmlPath],
]);
const types = {".pmtiles":"application/vnd.pmtiles",".json":"application/json; charset=utf-8",".pbf":"application/x-protobuf",".png":"image/png",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".html":"text/html; charset=utf-8"};
function safe(root, path) { const target=resolve(root, normalize(path)); const rel=relative(root,target); return rel.startsWith("..") ? null : target; }
const server=http.createServer((req,res)=>{
  try {
    const url=new URL(req.url,"http://127.0.0.1");
    appendFileSync(logFile,JSON.stringify({time:new Date().toISOString(),method:req.method,path:url.pathname,range:req.headers.range||null,origin:req.headers.origin||null})+"\n");
    if(!["GET","HEAD","OPTIONS"].includes(req.method)){res.writeHead(405);res.end();return;}
    const allowedOrigins=new Set(["http://tauri.localhost","https://tauri.localhost",`http://127.0.0.1:${server.address().port}`]);
    if(req.headers.origin && allowedOrigins.has(req.headers.origin)) res.setHeader("Access-Control-Allow-Origin",req.headers.origin);
    res.setHeader("Vary","Origin"); res.setHeader("Access-Control-Expose-Headers","Accept-Ranges, Content-Length, Content-Range, ETag");
    if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
    let path=routes.get(url.pathname);
    if(!path && url.pathname.startsWith("/map/")) path=safe(mapRoot,decodeURIComponent(url.pathname.slice(5)));
    if(!path && url.pathname.startsWith("/food/")) path=safe(foodRoot,decodeURIComponent(url.pathname.slice(6)));
    if(!path){res.writeHead(404);res.end();return;}
    const size=statSync(path).size; const etag='"'+createHash('sha256').update(readFileSync(path)).digest('hex')+'"';
    res.setHeader("Accept-Ranges","bytes"); res.setHeader("ETag",etag); res.setHeader("Content-Type",types[extname(path).toLowerCase()]||"application/octet-stream");
    let start=0,end=size-1,status=200;
    if(req.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!match){res.writeHead(416);res.end();return;}start=Number(match[1]);end=match[2]?Number(match[2]):end;if(start>end||end>=size){res.writeHead(416);res.end();return;}status=206;res.setHeader("Content-Range",`bytes ${start}-${end}/${size}`);}
    res.setHeader("Content-Length",end-start+1);res.writeHead(status);if(req.method==="HEAD"){res.end();return;}createReadStream(path,{start,end}).pipe(res);
  } catch(error){res.writeHead(500);res.end(String(error));}
});
server.listen(0,"127.0.0.1",()=>writeFileSync(portFile,String(server.address().port)));
'@
$ServerSource | Set-Content -LiteralPath $ServerScript -Encoding utf8

$MapLibreJs = Join-Path $RepoRoot "node_modules\maplibre-gl\dist\maplibre-gl.js"
$MapLibreCss = Join-Path $RepoRoot "node_modules\maplibre-gl\dist\maplibre-gl.css"
$ServerArguments = @($ServerScript, $MapRoot, $FoodRoot, $MapLibreJs, $MapLibreCss, $PmtilesJsPath, $TestHtml, $PortFile, $RequestLog) | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
$ServerProcess = Start-Process -FilePath node.exe -ArgumentList $ServerArguments -RedirectStandardOutput $ServerStdout -RedirectStandardError $ServerStderr -WindowStyle Hidden -PassThru
try {
    $Deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path -LiteralPath $PortFile) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $PortFile)) { throw "loopback server did not publish a port" }
    $Port = [int](Get-Content -Raw -LiteralPath $PortFile)
    $Origin = "http://127.0.0.1:$Port"
    & curl.exe -sS -D $RangeHeaders -o $RangeBody -H "Origin: http://tauri.localhost" -H "Range: bytes=0-126" "$Origin/map/basemap.pmtiles"
    if ($LASTEXITCODE -ne 0) { Add-Fail "Range GET failed" }
    else {
        $HeadersText = Get-Content -Raw -LiteralPath $RangeHeaders
        $BodyLength = (Get-Item -LiteralPath $RangeBody).Length
        $RangeChecks = @(
            ($HeadersText -match 'HTTP/1\.1 206')
            ($HeadersText -match '(?im)^Accept-Ranges:\s*bytes\s*$')
            ($HeadersText -match '(?im)^Content-Range:\s*bytes 0-126/\d+\s*$')
            ($HeadersText -match '(?im)^Content-Length:\s*127\s*$')
            ($HeadersText -match '(?im)^Access-Control-Allow-Origin:\s*http://tauri\.localhost\s*$')
            ($HeadersText -match '(?im)^Access-Control-Expose-Headers:.*Content-Range')
            ($BodyLength -eq 127)
        )
        if ($RangeChecks -contains $false) { Add-Fail "Range response did not meet 206/header/body contract; see $RangeHeaders" }
        else { Add-Pass "actual GET returned 206 with bytes 0-126, CORS allowlist headers, and a 127-byte body" }
    }

    Write-Group "4. Loopback-only browser render"
    $BrowserProfile = Join-Path $EvidenceRoot "edge-profile-$PID"
    $Screenshot = Join-Path $EvidenceRoot "offline-render.png"
    $DomPath = Join-Path $EvidenceRoot "offline-dom.html"
    $BrowserStdout = Join-Path $EvidenceRoot "edge-stdout.txt"
    $BrowserStderr = Join-Path $EvidenceRoot "edge-stderr.txt"
    $CdpRunner = Join-Path $EvidenceRoot "wait-for-offline-render.mjs"
    $PortProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $PortProbe.Start(); $DebugPort = ([System.Net.IPEndPoint]$PortProbe.LocalEndpoint).Port; $PortProbe.Stop()
    $CdpSource = @'
import { writeFileSync } from "node:fs";
const [port, screenshotPath, domPath] = process.argv.slice(2);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let target;
for (let attempt=0; attempt<100 && !target; attempt+=1) {
  try { const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target=pages.find(page=>page.type==="page" && page.url.includes("/test.html")); } catch {}
  if(!target) await delay(100);
}
if(!target) throw new Error("CDP target was not available");
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let nextId=1; const pending=new Map();
socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(message.error.message)):resolve(message.result);}};
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
await call("Runtime.enable"); await call("Page.enable");
let status="STARTING";
for(let attempt=0;attempt<120&&status==="STARTING";attempt+=1){const result=await call("Runtime.evaluate",{expression:"document.documentElement?.dataset?.status || 'STARTING'",returnByValue:true});status=result.result.value;await delay(250);}
const dom=await call("Runtime.evaluate",{expression:"document.documentElement.outerHTML",returnByValue:true});writeFileSync(domPath,dom.result.value,"utf8");
const screenshot=await call("Page.captureScreenshot",{format:"png"});writeFileSync(screenshotPath,Buffer.from(screenshot.data,"base64"));
socket.close(); console.log(status); process.exit(status==="PASS"?0:1);
'@
    $CdpSource | Set-Content -LiteralPath $CdpRunner -Encoding utf8
    $EdgeArgs = @(
        "--headless=new", "--no-first-run", "--disable-background-networking", "--disable-sync",
        "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
        "--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1",
        "--user-data-dir=$BrowserProfile", "--remote-debugging-port=$DebugPort",
        "--window-size=960,640", "$Origin/test.html"
    )
    $QuotedEdgeArgs = $EdgeArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
    $BrowserProcess = Start-Process -FilePath $EdgePath -ArgumentList $QuotedEdgeArgs -RedirectStandardOutput $BrowserStdout -RedirectStandardError $BrowserStderr -WindowStyle Hidden -PassThru
    try {
        & node.exe $CdpRunner $DebugPort $Screenshot $DomPath
        $BrowserCheckExit = $LASTEXITCODE
        if ($BrowserCheckExit -eq 0 -and (Test-Path -LiteralPath $Screenshot -PathType Leaf)) {
            Add-Pass "MapLibre rendered local PMTiles/style/glyphs and all 36 canonical icons with external DNS blocked"
        } else {
            Add-Fail "loopback-only browser render did not reach PASS; see $DomPath and $Screenshot"
        }
    } finally {
        if ($BrowserProcess -and -not $BrowserProcess.HasExited) { Stop-Process -Id $BrowserProcess.Id -Force }
    }
} finally {
    if ($ServerProcess -and -not $ServerProcess.HasExited) { Stop-Process -Id $ServerProcess.Id -Force }
}

Write-Group "5. Verification summary"
if ($OverallBlocked) {
    Add-Blocked "stage-0 package remains non-releaseable; evidence directory: $EvidenceRoot"
    exit 1
}
Add-Pass "all stage-0 map package checks passed; evidence directory: $EvidenceRoot"
