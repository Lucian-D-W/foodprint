[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BuildDir,

    [Parameter(Mandatory = $true)]
    [string]$PmtilesPath,

    [string]$TileJsonUrl = "https://tiles.openfreemap.org/planet",

    [switch]$AllowBlockedCandidate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$BuildRoot = [System.IO.Path]::GetFullPath($BuildDir)
$OutputRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "resources\map-default"))
$FrozenBounds = @(113.30000, 23.11000, 113.33000, 23.13500)
$FrozenCenter = @(113.3158, 23.1220, 15.15)
$FrozenLayers = @(
    "building", "landcover", "landuse", "park", "place",
    "transportation", "transportation_name", "water", "water_name", "waterway"
)
$TargetMaxZoom = 16
$UserAgent = "FoodMap-Stage0/1.0 (+local asset preparation)"
$PmtilesJsVersion = "4.5.0"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Group([string]$Name) {
    Write-Host "`n=== $Name ==="
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-SafeBuildRoot {
    if ($BuildRoot -eq $RepoRoot -or $RepoRoot.StartsWith($BuildRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "BLOCKED: BuildDir must be an explicit directory outside the repository: $BuildRoot"
    }
    if ($BuildRoot -match '^[A-Za-z]:\\?$') {
        throw "BLOCKED: BuildDir cannot be a drive root: $BuildRoot"
    }
}

function Get-TileX([double]$Longitude, [int]$Zoom) {
    $Count = [math]::Pow(2, $Zoom)
    return [int][math]::Floor((($Longitude + 180.0) / 360.0) * $Count)
}

function Get-TileY([double]$Latitude, [int]$Zoom) {
    $LatRad = $Latitude * [math]::PI / 180.0
    $Count = [math]::Pow(2, $Zoom)
    return [int][math]::Floor((1.0 - ([math]::Log([math]::Tan($LatRad) + (1.0 / [math]::Cos($LatRad))) / [math]::PI)) / 2.0 * $Count)
}

Assert-SafeBuildRoot
if (-not (Test-Path -LiteralPath $PmtilesPath -PathType Leaf)) {
    throw "BLOCKED: PMTiles CLI not found at $PmtilesPath. Download a pinned official release; do not silently skip verify."
}

$PmtilesVersion = (& $PmtilesPath version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($PmtilesVersion)) {
    throw "BLOCKED: PMTiles CLI version command failed at $PmtilesPath"
}

$InputsDir = Join-Path $BuildRoot "inputs"
$TilesDir = Join-Path $BuildRoot "tiles"
$StagingDir = Join-Path $BuildRoot "staging"
$EvidenceDir = Join-Path $BuildRoot "evidence"
foreach ($Directory in @($InputsDir, $TilesDir, $StagingDir, $EvidenceDir, $OutputRoot)) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
}

Write-Group "1. Source and schema preflight"
$AccessedAt = (Get-Date).ToUniversalTime().ToString("o")
$TileJson = Invoke-RestMethod -Uri $TileJsonUrl -Headers @{ "User-Agent" = $UserAgent }
$TileJsonPath = Join-Path $InputsDir "openfreemap-tilejson.json"
$TileJson | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $TileJsonPath -Encoding utf8

if (-not $TileJson.tiles -or $TileJson.tiles.Count -ne 1) {
    throw "BLOCKED: expected exactly one versioned vector tile template in TileJSON"
}
$TileTemplate = [string]$TileJson.tiles[0]
if ($TileTemplate -notmatch '/planet/(?<build>[0-9]{8}_[0-9]{6}_pt)/') {
    throw "BLOCKED: tile URL is not pinned to a recognizable dated OpenFreeMap build: $TileTemplate"
}
$SourceBuildId = $Matches.build
$PmtilesJsUrl = "https://unpkg.com/pmtiles@$PmtilesJsVersion/dist/pmtiles.js"
$PmtilesJsPath = Join-Path $InputsDir "pmtiles-$PmtilesJsVersion.js"
Invoke-WebRequest -Uri $PmtilesJsUrl -OutFile $PmtilesJsPath -Headers @{ "User-Agent" = $UserAgent }
$MapLibrePackage = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "node_modules\maplibre-gl\package.json") | ConvertFrom-Json
$SourceDate = [datetime]::ParseExact($SourceBuildId.Substring(0, 8), "yyyyMMdd", [System.Globalization.CultureInfo]::InvariantCulture).ToString("yyyy-MM-dd")
$ActualMaxZoom = [int]$TileJson.maxzoom
$AvailableLayers = @($TileJson.vector_layers | ForEach-Object { [string]$_.id })
$MissingLayers = @($FrozenLayers | Where-Object { $_ -notin $AvailableLayers })
if ($MissingLayers.Count -gt 0) {
    throw "BLOCKED: source TileJSON is missing frozen source-layer(s): $($MissingLayers -join ', ')"
}
if ($ActualMaxZoom -lt $TargetMaxZoom -and -not $AllowBlockedCandidate) {
    throw "BLOCKED: source maxzoom is $ActualMaxZoom but the frozen target is $TargetMaxZoom. Re-run with -AllowBlockedCandidate only to produce an explicitly non-release candidate."
}
Write-Host "PASS source build: $SourceBuildId"
Write-Host "PASS source layers: all $($FrozenLayers.Count) frozen layers are declared"
if ($ActualMaxZoom -lt $TargetMaxZoom) {
    Write-Warning "BLOCKED candidate: source maxzoom $ActualMaxZoom is below frozen target $TargetMaxZoom"
}

Write-Group "2. Download bounded vector tiles"
$TileCount = 0
for ($Zoom = 0; $Zoom -le $ActualMaxZoom; $Zoom += 1) {
    $MinX = Get-TileX $FrozenBounds[0] $Zoom
    $MaxX = Get-TileX $FrozenBounds[2] $Zoom
    $MinY = Get-TileY $FrozenBounds[3] $Zoom
    $MaxY = Get-TileY $FrozenBounds[1] $Zoom
    for ($X = $MinX; $X -le $MaxX; $X += 1) {
        for ($Y = $MinY; $Y -le $MaxY; $Y += 1) {
            $RelativeTile = "$Zoom/$X/$Y.pbf"
            $Destination = Join-Path $TilesDir ($RelativeTile -replace '/', '\')
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
            $Url = $TileTemplate.Replace("{z}", [string]$Zoom).Replace("{x}", [string]$X).Replace("{y}", [string]$Y)
            & curl.exe --fail --silent --show-error --location --retry 3 --user-agent $UserAgent --output $Destination $Url
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
                throw "BLOCKED: failed to download tile $RelativeTile from $Url"
            }
            $TileCount += 1
        }
    }
}
Write-Host "PASS downloaded tiles: $TileCount files for z0-$ActualMaxZoom"

Write-Group "3. Build MBTiles and PMTiles v3"
$PythonScript = Join-Path $BuildRoot "build_mbtiles.py"
$PythonSource = @'
import json, pathlib, sqlite3, sys

tiles_root = pathlib.Path(sys.argv[1])
tilejson_path = pathlib.Path(sys.argv[2])
output_path = pathlib.Path(sys.argv[3])
bounds = sys.argv[4]
center = sys.argv[5]
minzoom = int(sys.argv[6])
maxzoom = int(sys.argv[7])

tilejson = json.loads(tilejson_path.read_text(encoding="utf-8-sig"))
if output_path.exists():
    output_path.unlink()
connection = sqlite3.connect(output_path)
connection.executescript("""
CREATE TABLE metadata (name TEXT, value TEXT);
CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
""")
metadata = {
    "name": "Food Map Zhujiang New Town candidate",
    "type": "baselayer",
    "version": "1",
    "description": f"Bounded extract from {tilejson.get('name', 'OpenFreeMap')} {tilejson.get('version', 'unknown')}",
    "format": "pbf",
    "bounds": bounds,
    "center": center,
    "minzoom": str(minzoom),
    "maxzoom": str(maxzoom),
    "attribution": tilejson["attribution"],
    "json": json.dumps({"vector_layers": tilejson["vector_layers"]}, separators=(",", ":")),
}
connection.executemany("INSERT INTO metadata(name, value) VALUES (?, ?)", metadata.items())
count = 0
for path in sorted(tiles_root.glob("*/*/*.pbf")):
    z, x, filename = path.relative_to(tiles_root).parts
    y = pathlib.Path(filename).stem
    z, x, y = int(z), int(x), int(y)
    tms_y = (1 << z) - 1 - y
    connection.execute("INSERT INTO tiles VALUES (?, ?, ?, ?)", (z, x, tms_y, path.read_bytes()))
    count += 1
connection.commit()
connection.close()
print(f"inserted {count} tiles")
'@
$PythonSource | Set-Content -LiteralPath $PythonScript -Encoding utf8
$MbtilesPath = Join-Path $StagingDir "foodmap-zhujiang-new-town-z0-z$ActualMaxZoom.mbtiles"
$BoundsText = ($FrozenBounds -join ',')
$MbtilesCenterText = "$($FrozenCenter[0]),$($FrozenCenter[1]),$ActualMaxZoom"
& python.exe $PythonScript $TilesDir $TileJsonPath $MbtilesPath $BoundsText $MbtilesCenterText 0 $ActualMaxZoom
if ($LASTEXITCODE -ne 0) { throw "BLOCKED: MBTiles construction failed" }

$PmtilesOutput = Join-Path $StagingDir "basemap.pmtiles"
if (Test-Path -LiteralPath $PmtilesOutput) { Remove-Item -LiteralPath $PmtilesOutput -Force }
& $PmtilesPath convert $MbtilesPath $PmtilesOutput
if ($LASTEXITCODE -ne 0) { throw "BLOCKED: pmtiles convert failed" }
$HeaderJsonText = (& $PmtilesPath show $PmtilesOutput --header-json 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "BLOCKED: pmtiles show --header-json failed" }
$MetadataJsonText = (& $PmtilesPath show $PmtilesOutput --metadata 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "BLOCKED: pmtiles show --metadata failed" }
$VerifyText = (& $PmtilesPath verify $PmtilesOutput 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "BLOCKED: pmtiles verify failed: $VerifyText" }
$HeaderJsonText | Set-Content -LiteralPath (Join-Path $EvidenceDir "pmtiles-header.json") -Encoding utf8
$MetadataJsonText | Set-Content -LiteralPath (Join-Path $EvidenceDir "pmtiles-metadata.json") -Encoding utf8
$VerifyText | Set-Content -LiteralPath (Join-Path $EvidenceDir "pmtiles-verify.txt") -Encoding utf8
Write-Host "PASS pmtiles verify: $VerifyText"

Write-Group "4. Export frozen Hybrid style and glyphs"
$EsbuildCli = Join-Path $RepoRoot "node_modules\esbuild\bin\esbuild"
if (-not (Test-Path -LiteralPath $EsbuildCli -PathType Leaf)) {
    throw "BLOCKED: repository-local esbuild is unavailable; refusing to hand-copy the frozen style"
}
$HybridBundle = Join-Path $BuildRoot "hybrid.bundle.mjs"
& node.exe $EsbuildCli (Join-Path $RepoRoot "src\styles\hybrid.ts") --bundle --platform=node --format=esm --outfile=$HybridBundle
if ($LASTEXITCODE -ne 0) { throw "BLOCKED: Hybrid style bundle failed" }
$StyleOutput = Join-Path $StagingDir "style.json"
$StyleRunner = Join-Path $BuildRoot "export_style.mjs"
$RunnerSource = @'
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [bundlePath, outputPath] = process.argv.slice(2);
const { hybridStyle } = await import(pathToFileURL(bundlePath));
const style = structuredClone(hybridStyle);
style.glyphs = "fonts/{fontstack}/{range}.pbf";
style.sources.openmaptiles.url = "pmtiles://basemap.pmtiles";
style.sources.openmaptiles.attribution = "OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors";
await writeFile(outputPath, `${JSON.stringify(style, null, 2)}\n`, "utf8");
'@
$RunnerSource | Set-Content -LiteralPath $StyleRunner -Encoding utf8
& node.exe $StyleRunner $HybridBundle $StyleOutput
if ($LASTEXITCODE -ne 0) { throw "BLOCKED: Hybrid style export failed" }

$FontStacks = @("Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic")
$GlyphRanges = @("0-255")
foreach ($FontStack in $FontStacks) {
    foreach ($Range in $GlyphRanges) {
        $EncodedStack = [uri]::EscapeDataString($FontStack)
        $Url = "https://tiles.openfreemap.org/fonts/$EncodedStack/$Range.pbf"
        $Destination = Join-Path $StagingDir "fonts\$FontStack\$Range.pbf"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Invoke-WebRequest -Uri $Url -OutFile $Destination -Headers @{ "User-Agent" = $UserAgent }
        if ((Get-Item -LiteralPath $Destination).Length -eq 0) { throw "BLOCKED: empty glyph file from $Url" }
    }
}
Write-Host "PASS glyphs: $($FontStacks.Count) frozen stacks, ranges $($GlyphRanges -join ', ')"

Write-Group "5. Publish candidate and write real manifest"
$PublishedTiles = Join-Path $OutputRoot "basemap.pmtiles"
$PublishedStyle = Join-Path $OutputRoot "style.json"
Copy-Item -LiteralPath $PmtilesOutput -Destination $PublishedTiles -Force
Copy-Item -LiteralPath $StyleOutput -Destination $PublishedStyle -Force
foreach ($FontStack in $FontStacks) {
    foreach ($Range in $GlyphRanges) {
        $Source = Join-Path $StagingDir "fonts\$FontStack\$Range.pbf"
        $Destination = Join-Path $OutputRoot "fonts\$FontStack\$Range.pbf"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
}

$Hashes = [ordered]@{
    "basemap.pmtiles" = Get-Sha256 $PublishedTiles
    "style.json" = Get-Sha256 $PublishedStyle
}
foreach ($FontStack in $FontStacks) {
    foreach ($Range in $GlyphRanges) {
        $Relative = "fonts/$FontStack/$Range.pbf"
        $Hashes[$Relative] = Get-Sha256 (Join-Path $OutputRoot ($Relative -replace '/', '\'))
    }
}

$Header = $HeaderJsonText | ConvertFrom-Json
$Metadata = $MetadataJsonText | ConvertFrom-Json
$Blockers = @()
if ($ActualMaxZoom -lt $TargetMaxZoom) {
    $Blockers += "Source build maxzoom is $ActualMaxZoom; frozen stage-0 target is $TargetMaxZoom. The package is a real z0-$ActualMaxZoom candidate but is not release-complete."
}
$Manifest = [ordered]@{
    schemaVersion = 1
    packageId = "personal-default"
    packageVersion = "2026.08.30.1"
    releaseStatus = $(if ($Blockers.Count -eq 0) { "PASS" } else { "BLOCKED" })
    blockers = $Blockers
    pmtilesSpecVersion = 3
    basemapSchema = "OpenMapTiles $($TileJson.version) via OpenFreeMap weekly build"
    tiles = "basemap.pmtiles"
    style = "style.json"
    bounds = $FrozenBounds
    center = $FrozenCenter
    minZoom = 0
    maxZoom = $ActualMaxZoom
    targetMaxZoom = $TargetMaxZoom
    pitch = 0
    bearing = 0
    sourceId = "openmaptiles"
    sourceLayers = $FrozenLayers
    attribution = "OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors"
    sourceCreatedAt = $SourceDate
    sourceDescription = "Bounded XYZ vector tiles fetched from pinned OpenFreeMap build $SourceBuildId for the frozen bounds, assembled into MBTiles without schema rewriting, then converted with $PmtilesVersion."
    sourceUrl = $TileJsonUrl
    sourceTileTemplate = $TileTemplate
    sourceAccessedAt = $AccessedAt
    sourceBuildId = $SourceBuildId
    buildCommand = "powershell -File scripts/prepare-map-package.ps1 -BuildDir '$BuildRoot' -PmtilesPath '$([System.IO.Path]::GetFullPath($PmtilesPath))' -AllowBlockedCandidate"
    pmtilesCliVersion = $PmtilesVersion
    pmtilesJsVersion = $PmtilesJsVersion
    pmtilesHeader = $Header
    vectorTileMetadata = $Metadata
    glyphs = [ordered]@{
        template = "fonts/{fontstack}/{range}.pbf"
        fontStacks = $FontStacks
        ranges = $GlyphRanges
        coverage = "Bundled Latin-1 range for all frozen stacks; CJK is intentionally supplied at runtime by MapLibre localIdeographFontFamily per the stage-0 contract."
        source = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"
    }
    sprite = $null
    textures = @()
    sha256 = $Hashes
    provenance = [ordered]@{
        tileProvider = "OpenFreeMap"
        providerProject = "https://github.com/hyperknot/openfreemap"
        providerLicense = "MIT for OpenFreeMap code; map data remains subject to OpenStreetMap/OpenMapTiles attribution"
        providerTerms = "https://openfreemap.org/terms/"
        pmtilesRelease = "https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2"
        pmtilesBinarySha256 = Get-Sha256 ([System.IO.Path]::GetFullPath($PmtilesPath))
        pmtilesJsSource = $PmtilesJsUrl
        pmtilesJsSha256 = Get-Sha256 $PmtilesJsPath
        maplibreGlVersion = [string]$MapLibrePackage.version
        preparedAt = (Get-Date).ToUniversalTime().ToString("o")
        downloadedTileCount = $TileCount
    }
}
$ManifestPath = Join-Path $OutputRoot "manifest.json"
$ManifestJson = $Manifest | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson + "`n", $Utf8NoBom)
Write-Host "PASS manifest: $ManifestPath"
if ($Blockers.Count -gt 0) {
    Write-Warning "BLOCKED: candidate resources were prepared honestly, but stage 0 release criteria remain unmet: $($Blockers -join '; ')"
    exit 2
}
Write-Host "PASS map package: release-ready resource checks can proceed"
