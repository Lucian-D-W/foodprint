[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CandidatePmtilesPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateHeaderPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateMetadataPath,

  [Parameter(Mandatory = $true)]
  [string]$PmtilesPath,

  [string]$RepoRoot = '',
  [string]$PackageVersion = '2026.08.31.1',
  [string]$SourceBuildId = 'osm-api-20260830-zhujiang-new-town',
  [string]$SourceAccessedAt = '2026-08-30T15:51:17Z'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Resolve-ExistingFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label does not exist: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-Numbers([object[]]$Actual, [double[]]$Expected, [string]$Label) {
  if ($null -eq $Actual -or $Actual.Count -ne $Expected.Count) {
    throw "$Label has an unexpected length"
  }
  for ($i = 0; $i -lt $Expected.Count; $i += 1) {
    if ([double]$Actual[$i] -ne $Expected[$i]) {
      throw "$Label does not match the frozen value"
    }
  }
}

$candidate = Resolve-ExistingFile $CandidatePmtilesPath 'Candidate PMTiles'
$headerPath = Resolve-ExistingFile $CandidateHeaderPath 'Candidate header'
$metadataPath = Resolve-ExistingFile $CandidateMetadataPath 'Candidate metadata'
$pmtiles = Resolve-ExistingFile $PmtilesPath 'PMTiles CLI'
$manifestPath = Resolve-ExistingFile (Join-Path $RepoRoot 'resources/map-default/manifest.json') 'Map manifest'
$stylePath = Resolve-ExistingFile (Join-Path $RepoRoot 'resources/map-default/style.json') 'Map style'
$mapRoot = (Resolve-Path (Join-Path $RepoRoot 'resources/map-default')).Path
$destination = Join-Path $mapRoot 'basemap.pmtiles'

$header = Get-Content -Raw -Encoding UTF8 $headerPath | ConvertFrom-Json
$metadata = Get-Content -Raw -Encoding UTF8 $metadataPath | ConvertFrom-Json
$manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json

if ($header.tile_type -ne 'mvt') { throw 'Candidate PMTiles tile_type must be mvt' }
if ($header.tile_compression -ne 'gzip') { throw 'Candidate PMTiles tile_compression must be gzip' }
if ([int]$header.minzoom -ne 0 -or [int]$header.maxzoom -ne 16) { throw 'Candidate PMTiles must cover minzoom 0 through maxzoom 16' }
Assert-Numbers $header.bounds ([double[]](113.30, 23.11, 113.33, 23.135)) 'Candidate PMTiles bounds'
if ($metadata.version -ne '3.16.0') { throw "Candidate metadata version must be 3.16.0, got $($metadata.version)" }

$frozenLayers = @('building', 'landcover', 'landuse', 'park', 'place', 'transportation', 'transportation_name', 'water', 'water_name', 'waterway')
$metadataLayerIds = @($metadata.vector_layers | ForEach-Object { $_.id })
$unexpected = @($metadataLayerIds | Where-Object { $_ -notin $frozenLayers })
if ($unexpected.Count -gt 0) { throw "Candidate metadata contains unexpected layers: $($unexpected -join ', ')" }

$verifyOutput = & $pmtiles verify $candidate 2>&1
if ($LASTEXITCODE -ne 0) { throw "PMTiles verify failed: $($verifyOutput -join ' ')" }

$candidateHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
Copy-Item -LiteralPath $candidate -Destination $destination -Force
$adoptedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($candidateHash -ne $adoptedHash) { throw 'Adopted PMTiles hash differs from candidate hash' }

$manifest.packageVersion = $PackageVersion
$manifest.releaseStatus = 'PASS'
$manifest.blockers = @()
$manifest.basemapSchema = 'OpenMapTiles 3.16.0 via Planetiler 0.10.2'
$manifest.maxZoom = 16
$manifest.sourceCreatedAt = '2026-08-30'
$manifest.sourceDescription = 'Bounded OpenStreetMap API extract for the frozen Zhujiang New Town bounds, rendered with the OpenMapTiles 3.16.0 Planetiler profile at maxzoom 16; official water polygons, lake centerlines, and Natural Earth inputs are recorded outside the release package.'
$manifest.sourceUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=113.30000,23.11000,113.33000,23.13500'
$manifest.sourceTileTemplate = $null
$manifest.sourceAccessedAt = $SourceAccessedAt
$manifest.sourceBuildId = $SourceBuildId
$manifest.buildCommand = 'java.exe -Xmx8g -jar planetiler-0.10.2.jar --force --osm_path inputs/osm-api-20260830-zhujiang-new-town.osm.pbf --bounds 113.3,23.11,113.33,23.135 --minzoom 0 --maxzoom 16 --render_maxzoom 16 --only-layers building,landcover,landuse,park,place,transportation,transportation_name,water,water_name,waterway --download=false --output staging/basemap-z16.pmtiles'
$manifest.pmtilesCliVersion = 'pmtiles 1.31.2, commit a3e4951ea6a0477b784c27c1dcbfd9c130878c5a, built at 2026-07-22T18:59:03Z'
$manifest.pmtilesHeader = $header
$manifest.vectorTileMetadata = $metadata
$manifest.provenance.tileProvider = 'OpenStreetMap via OpenMapTiles Planetiler'
$manifest.provenance.providerProject = 'https://github.com/openmaptiles/planetiler-openmaptiles'
$manifest.provenance.providerLicense = 'OpenMapTiles schema/cartography CC BY 4.0; OpenStreetMap data ODbL'
$manifest.provenance.providerTerms = 'https://www.openstreetmap.org/copyright'
$manifest.provenance.preparedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifest.provenance.downloadedTileCount = 0
$manifest.sha256.'basemap.pmtiles' = $adoptedHash
$manifest.sha256.'style.json' = (Get-FileHash -LiteralPath $stylePath -Algorithm SHA256).Hash.ToLowerInvariant()

$manifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Output "Adopted candidate: $destination"
Write-Output "PMTiles SHA-256: $adoptedHash"
Write-Output "Manifest packageVersion: $($manifest.packageVersion)"
Write-Output "Manifest releaseStatus: $($manifest.releaseStatus)"
